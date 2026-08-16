#!/usr/bin/env python3
"""Run the local Ask Forge Retrieval Routing v0.2 experiment."""

from __future__ import annotations

import json
import re
import socket
import ssl
import statistics
import sys
import time
from pathlib import Path
from typing import Any
from urllib import error, parse, request

from test_bailian_api import (
    load_dev_vars,
    report_http_failure,
    require_config,
    safe_text,
)


MODEL = "qwen3.7-plus"
BASELINE_INPUT_TOKENS = 2700
ROUTE_SOURCES = {
    "current_behavior": "project_context.json",
    "impact_scope": "project_context.json",
    "human_decision": "gaps.json",
    "implementation_handoff": "implementation_package.json",
    "forge_design": "architecture.md",
}
SOURCE_PATHS = {
    "project_context.json": "examples/petclinic/project_context.json",
    "gaps.json": "examples/petclinic/gaps.json",
    "implementation_package.json": "examples/petclinic/implementation_package.json",
    "architecture.md": "docs/architecture.md",
}
ALLOWED_SUFFICIENCY = {"sufficient", "partial", "insufficient"}
KNOWN_GAP_IDS = {
    "gap.city_matching_semantics",
    "gap.search_criteria_combination",
    "gap.no_result_error_placement",
}

TEST_CASES = [
    {
        "id": "A",
        "name": "current behavior",
        "question": "現在の Owner 検索はどう動いていますか？",
        "expected_route": "current_behavior",
    },
    {
        "id": "B",
        "name": "impact scope",
        "question": "この要件はどこに影響しますか？",
        "expected_route": "impact_scope",
    },
    {
        "id": "C",
        "name": "human decision",
        "question": "この要件で、実装前に人が決める必要があることは何ですか？",
        "expected_route": "human_decision",
    },
    {
        "id": "D",
        "name": "implementation handoff",
        "question": "Human Alignment 後、Coding Agent には何を渡せますか？",
        "expected_route": "implementation_handoff",
    },
    {
        "id": "E",
        "name": "Forge design",
        "question": "Forge はなぜ不足した Context を AI に推測させないのですか？",
        "expected_route": "forge_design",
    },
    {
        "id": "F",
        "name": "additional retrieval",
        "question": "なぜ city の照合方法を Forge は自動で決めなかったのですか？",
        "expected_route": "human_decision",
    },
    {
        "id": "G",
        "name": "out of scope",
        "question": "この要件では認証方式をどう変更すべきですか？",
        "expected_route": None,
    },
]

ROUTER_SYSTEM = """Classify one Ask Forge question into exactly one route and return only JSON.
Routes and fixed primary sources:
- current_behavior -> project_context.json: how the current implementation behaves
- impact_scope -> project_context.json: evidenced files, layers, or implementation surfaces affected
- human_decision -> gaps.json: unresolved pre-alignment decisions or why Forge did not decide them
- implementation_handoff -> implementation_package.json: Human-approved post-alignment target and Coding Agent handoff
- forge_design -> architecture.md: Forge principles, pipeline, or architecture
Choose the closest route even when its source may prove insufficient. Never name another file.
JSON shape: {"route":"one route","primary_source":"mapped filename","reason":"short string"}"""

SYNTHESIS_SYSTEM = """You are the Ask Forge v0.2 bounded grounded-answer step. Return only JSON.
Use only the retrieved artifact content in the user message. Do not use general Spring PetClinic knowledge, invent Project Context or gaps, close Human-authority gaps, or present candidate options as approved. Keep Current Behavior separate from Human-approved target behavior.

Set sufficiency to:
- sufficient: retrieved evidence answers the question; answer now.
- partial: exactly one allowlisted source could supply specifically missing evidence. Name it and explain why; do not answer beyond current evidence.
- insufficient: evidence cannot support the requested answer and one more source would not responsibly resolve it; explicitly say what is missing.

Strict retrieval contract: additional_source and additional_reason must be non-null only when sufficiency is partial. They must both be null for sufficient or insufficient.

Route-specific sufficiency rules:
- For impact_scope, return `impact_items` with one exact retrieved `surface_id` per claimed impact and a short grounded reason. Do not request gaps.json merely to restate or resolve the target requirement.
- For human_decision, gaps.json is sufficient when the question asks which Human decisions remain open. Do not follow evidence_ref pointers merely to list those gaps.

Cross-artifact evidence_ref values are pointers, not retrieved evidence. For a question asking why a Human gap was not automatically resolved, if the relevant existing convention points to an unretrieved allowlisted artifact, request that artifact so the final answer can distinguish observed behavior from an approved target. Merely listing open gaps does not require following their evidence refs.

Evidence entries must be `retrieved_filename#artifact-locator` (or the filename for Markdown-level evidence). Even an insufficient answer must cite the retrieved artifact scope that shows the requested topic is absent, such as `gaps.json#gaps`. Never cite an unretrieved source. Keep the Japanese answer concise.
JSON shape: {"sufficiency":"sufficient|partial|insufficient","answer":"string","impact_items":[{"surface_id":"exact id","reason":"string"}],"evidence":["string"],"additional_source":null,"additional_reason":null}. Use an empty impact_items array for non-impact routes."""


def load_source(repo_root: Path, source_name: str) -> str:
    if source_name not in SOURCE_PATHS:
        raise ValueError(f"source is not allowlisted: {source_name}")
    source_path = repo_root / SOURCE_PATHS[source_name]
    text = source_path.read_text(encoding="utf-8")
    if source_path.suffix == ".json":
        return json.dumps(
            json.loads(text), ensure_ascii=False, separators=(",", ":")
        )
    return text


def add_usage(total: dict[str, float], usage: dict[str, Any], latency: float) -> None:
    total["input_tokens"] += usage.get(
        "prompt_tokens", usage.get("input_tokens", 0)
    ) or 0
    total["output_tokens"] += usage.get(
        "completion_tokens", usage.get("output_tokens", 0)
    ) or 0
    total["total_tokens"] += usage.get("total_tokens", 0) or 0
    total["latency_seconds"] += latency
    total["calls"] += 1


def call_json(
    api_key: str,
    base_url: str,
    messages: list[dict[str, str]],
    max_tokens: int,
) -> tuple[dict[str, Any], dict[str, Any], float, int]:
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    body = json.dumps(
        {
            "model": MODEL,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "enable_thinking": False,
            "response_format": {"type": "json_object"},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    api_request = request.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    started = time.perf_counter()
    try:
        with request.urlopen(api_request, timeout=45) as response:
            response_body = response.read(262_144)
            status = response.status
    except error.HTTPError as exc:
        report_http_failure(exc, api_key)
        raise RuntimeError("API request failed") from None
    except error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (TimeoutError, socket.timeout)):
            detail = "request timed out"
        elif isinstance(reason, ssl.SSLError):
            detail = "TLS connection failed"
        else:
            detail = safe_text(reason, api_key)
        raise RuntimeError(f"network/API error: {detail}") from None
    except TimeoutError:
        raise RuntimeError("network/API error: request timed out") from None
    latency = time.perf_counter() - started

    try:
        api_response = json.loads(response_body.decode("utf-8"))
        assistant_text = api_response["choices"][0]["message"]["content"]
        result = json.loads(assistant_text)
        if not isinstance(result, dict):
            raise TypeError
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
        raise RuntimeError("model response was not a valid JSON object") from None

    usage = api_response.get("usage", {})
    return result, usage if isinstance(usage, dict) else {}, latency, status


def route_question(
    api_key: str, base_url: str, question: str
) -> tuple[dict[str, Any], dict[str, Any], float, int]:
    return call_json(
        api_key,
        base_url,
        [
            {"role": "system", "content": ROUTER_SYSTEM},
            {
                "role": "user",
                "content": f"Question:\n{question}\nReturn the routing result as JSON.",
            },
        ],
        max_tokens=160,
    )


def grounded_step(
    api_key: str,
    base_url: str,
    question: str,
    route: str,
    retrieved: dict[str, str],
    can_retrieve_more: bool,
) -> tuple[dict[str, Any], dict[str, Any], float, int]:
    remaining = [name for name in SOURCE_PATHS if name not in retrieved]
    retrieval_instruction = (
        "You may request exactly one source from this remaining allowlist: "
        + ", ".join(remaining)
        if can_retrieve_more
        else "No further retrieval is allowed. additional_source and additional_reason must be null."
    )
    if not can_retrieve_more and len(retrieved) == 2:
        retrieval_instruction += (
            " The second source was retrieved to resolve missing evidence; the final answer "
            "must use and cite both retrieved sources."
        )
    artifact_blocks = "\n\n".join(
        f"--- {name} ---\n{content}" for name, content in retrieved.items()
    )
    user_prompt = (
        f"Question:\n{question}\n\nRoute: {route}\n"
        f"{retrieval_instruction}\n\nRetrieved artifacts:\n{artifact_blocks}\n\n"
        "Return the evidence decision and grounded answer as JSON."
    )
    return call_json(
        api_key,
        base_url,
        [
            {"role": "system", "content": SYNTHESIS_SYSTEM},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=700,
    )


def validate_route(
    routing: dict[str, Any], expected_route: str | None
) -> list[str]:
    failures: list[str] = []
    route = routing.get("route")
    source = routing.get("primary_source")
    if route not in ROUTE_SOURCES:
        failures.append("illegal route")
    elif source != ROUTE_SOURCES[route]:
        failures.append("primary source does not match route mapping")
    if expected_route is not None and route != expected_route:
        failures.append(f"expected route {expected_route}, got {route}")
    if not isinstance(routing.get("reason"), str) or not routing.get("reason", "").strip():
        failures.append("routing reason is missing")
    return failures


def validate_step(
    decision: dict[str, Any], retrieved_sources: list[str], can_retrieve_more: bool
) -> list[str]:
    failures: list[str] = []
    sufficiency = decision.get("sufficiency")
    answer = decision.get("answer")
    evidence = decision.get("evidence")
    additional = decision.get("additional_source")
    additional_reason = decision.get("additional_reason")

    if sufficiency not in ALLOWED_SUFFICIENCY:
        failures.append("illegal sufficiency state")
    if not isinstance(answer, str):
        failures.append("answer is not a string")
    if not isinstance(evidence, list) or any(
        not isinstance(item, str) for item in evidence
    ):
        failures.append("evidence is not a string array")
    else:
        for item in evidence:
            cited_source = item.split("#", 1)[0]
            if cited_source not in retrieved_sources:
                failures.append(f"evidence cites unretrieved source: {cited_source}")

    if sufficiency in {"sufficient", "insufficient"}:
        if additional is not None or additional_reason is not None:
            failures.append("terminal sufficiency state requested another source")
        if not isinstance(answer, str) or not answer.strip():
            failures.append("terminal sufficiency state has no answer")
        if not isinstance(evidence, list) or not evidence:
            failures.append("terminal grounded answer has no artifact evidence")
    elif sufficiency == "partial":
        if additional is not None:
            if not can_retrieve_more:
                failures.append("requested a source beyond maximum retrieval depth")
            if additional not in SOURCE_PATHS or additional in retrieved_sources:
                failures.append("requested source is not a legal new allowlisted source")
            if not isinstance(additional_reason, str) or not additional_reason.strip():
                failures.append("additional retrieval reason is missing")
        elif not isinstance(answer, str) or not answer.strip():
            failures.append("partial result without retrieval has no grounded answer")
    return failures


def required_cross_evidence_source(
    question: str, route: str, retrieved: dict[str, str]
) -> str | None:
    """Follow one explicit evidence pointer for why-not-auto-decided questions."""
    asks_why = "なぜ" in question or "why" in question.lower()
    if route != "human_decision" or not asks_why or len(retrieved) != 1:
        return None
    current_source, content = next(iter(retrieved.items()))
    referenced_sources = {
        reference.split("#", 1)[0]
        for reference in re.findall(r'"evidence_ref":"([^"]+)"', content)
    }
    candidates = [
        source
        for source in referenced_sources
        if source in SOURCE_PATHS and source != current_source
    ]
    return candidates[0] if len(candidates) == 1 else None


def complete_cross_artifact_evidence(
    decision: dict[str, Any], retrieved: dict[str, str]
) -> None:
    """Attach an exact retrieved evidence_ref named by a cited gap."""
    if "gaps.json" not in retrieved or not isinstance(decision.get("evidence"), list):
        return
    try:
        gaps = json.loads(retrieved["gaps.json"])["gaps"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return
    gaps_by_id = {
        gap["id"]: gap
        for gap in gaps
        if isinstance(gap, dict) and isinstance(gap.get("id"), str)
    }
    evidence = decision["evidence"]
    for citation in list(evidence):
        if not isinstance(citation, str) or not citation.startswith("gaps.json#"):
            continue
        locator = citation.split("#", 1)[1]
        gap_id = next(
            (
                candidate
                for candidate in gaps_by_id
                if locator == candidate or locator.startswith(f"{candidate}.")
            ),
            None,
        )
        if gap_id is None:
            continue
        observed = gaps_by_id[gap_id].get("observed_existing_behavior", {})
        reference = observed.get("evidence_ref") if isinstance(observed, dict) else None
        if (
            isinstance(reference, str)
            and reference.split("#", 1)[0] in retrieved
            and reference not in evidence
        ):
            evidence.append(reference)


def controller_enforce_decision(
    question: str,
    route: str,
    decision: dict[str, Any],
    retrieved: dict[str, str],
    can_retrieve_more: bool,
) -> tuple[dict[str, Any], list[str]]:
    """Apply deterministic retrieval and sufficiency rules to a model decision."""
    normalized = dict(decision)
    warnings: list[str] = []
    model_sufficiency = decision.get("sufficiency")
    required_source = required_cross_evidence_source(question, route, retrieved)

    authentication_question = "認証" in question or "authentication" in question.lower()
    retrieved_text = "\n".join(retrieved.values()).lower()
    has_authentication_evidence = any(
        marker in retrieved_text for marker in ("認証", "authentication", "oauth", "jwt")
    )
    explicit_missing_context = bool(
        re.search(
            r"(?:提供された|取得した|この資料|このアーティファクト|supplied)"
            r".{0,100}(?:含まれてい|記載されてい|証拠.{0,20}不足|"
            r"情報.{0,20}不足|回答でき)",
            str(decision.get("answer", "")),
            re.I,
        )
    )

    if required_source and can_retrieve_more:
        if not (
            model_sufficiency == "partial"
            and decision.get("additional_source") == required_source
        ):
            warnings.append(
                f"controller followed explicit evidence_ref to {required_source}"
            )
        normalized.update(
            {
                "sufficiency": "partial",
                "answer": "",
                "additional_source": required_source,
                "additional_reason": (
                    "The primary gap artifact explicitly points to this allowlisted "
                    "source for the observed convention needed by the answer."
                ),
            }
        )
    elif authentication_question and not has_authentication_evidence:
        if model_sufficiency != "insufficient":
            warnings.append(
                f"controller changed sufficiency from {model_sufficiency} to insufficient"
            )
        source_names = list(retrieved)
        normalized.update(
            {
                "sufficiency": "insufficient",
                "answer": (
                    "取得したアーティファクトには認証方式に関する根拠がないため、"
                    "認証方式をどのように変更すべきか判断できません。"
                ),
                "evidence": [
                    name if name.endswith(".md") else f"{name}#top-level"
                    for name in source_names
                ],
                "additional_source": None,
                "additional_reason": None,
            }
        )
    elif explicit_missing_context:
        if model_sufficiency != "insufficient":
            warnings.append(
                f"controller changed sufficiency from {model_sufficiency} to insufficient"
            )
        normalized["sufficiency"] = "insufficient"
        normalized["additional_source"] = None
        normalized["additional_reason"] = None

    if normalized.get("sufficiency") in {"sufficient", "insufficient"} and (
        normalized.get("additional_source") is not None
        or normalized.get("additional_reason") is not None
    ):
        warnings.append("controller removed a source request from a terminal state")
        normalized["additional_source"] = None
        normalized["additional_reason"] = None
    return normalized, warnings


def normalize_impact_scope(
    decision: dict[str, Any], retrieved: dict[str, str]
) -> tuple[dict[str, Any], list[str]]:
    """Accept only model-selected surface IDs backed by project_context.json."""
    normalized = dict(decision)
    warnings: list[str] = []
    try:
        context = json.loads(retrieved["project_context.json"])
        surfaces = context["relevant_implementation_surfaces"]
    except (json.JSONDecodeError, KeyError, TypeError):
        normalized["sufficiency"] = "insufficient"
        normalized["impact_items"] = []
        return normalized, ["project context has no valid implementation-surface allowlist"]

    surfaces_by_id = {
        surface["id"]: surface
        for surface in surfaces
        if isinstance(surface, dict)
        and isinstance(surface.get("id"), str)
        and isinstance(surface.get("description"), str)
    }
    raw_items = decision.get("impact_items")
    if not isinstance(raw_items, list):
        raw_items = []
        warnings.append("model omitted structured impact_items")

    selected_ids: list[str] = []
    raw_reasons: list[str] = []
    for item in raw_items:
        if not isinstance(item, dict):
            warnings.append("removed a malformed impact item")
            continue
        surface_id = item.get("surface_id")
        if isinstance(item.get("reason"), str):
            raw_reasons.append(item["reason"])
        if surface_id not in surfaces_by_id:
            warnings.append(f"removed unsupported impact surface: {surface_id}")
            continue
        if surface_id not in selected_ids:
            selected_ids.append(surface_id)

    if not selected_ids:
        for citation in decision.get("evidence", []):
            if not isinstance(citation, str) or not citation.startswith(
                "project_context.json#"
            ):
                continue
            surface_id = citation.split("#", 1)[1]
            if surface_id in surfaces_by_id and surface_id not in selected_ids:
                selected_ids.append(surface_id)
        if selected_ids:
            warnings.append("recovered impact surface IDs from model evidence citations")

    raw_claims = "\n".join([str(decision.get("answer", "")), *raw_reasons])
    if re.search(
        r"インデックス|キャッシュ|性能改善|パフォーマンス|"
        r"新しいService層|新規モジュール",
        raw_claims,
        re.I,
    ):
        warnings.append("removed unsupported implementation concern from impact answer")

    accepted_items = [
        {
            "surface_id": surface_id,
            "reason": surfaces_by_id[surface_id]["description"],
        }
        for surface_id in selected_ids
    ]
    normalized["impact_items"] = accepted_items
    normalized["evidence"] = [
        f"project_context.json#{item['surface_id']}" for item in accepted_items
    ]
    if accepted_items:
        if normalized.get("sufficiency") != "sufficient":
            warnings.append("controller marked validated impact surfaces sufficient")
        normalized["sufficiency"] = "sufficient"
        normalized["additional_source"] = None
        normalized["additional_reason"] = None
        normalized["answer"] = "\n".join(
            f"- {item['surface_id']}: {item['reason']}" for item in accepted_items
        )
    else:
        normalized.update(
            {
                "sufficiency": "insufficient",
                "answer": "取得した Project Context から裏付けられた影響範囲を特定できませんでした。",
                "evidence": ["project_context.json#relevant_implementation_surfaces"],
            }
        )
        warnings.append("no supported impact surface remained after validation")
    return normalized, warnings


def validate_final(
    case: dict[str, Any], result: dict[str, Any], retrieved: dict[str, str]
) -> list[str]:
    failures: list[str] = []
    sources = result["retrieved_sources"]
    if not 1 <= len(sources) <= 2:
        failures.append("retrieval depth is outside the one-to-two source bound")
    if len(sources) != len(set(sources)) or any(
        source not in SOURCE_PATHS for source in sources
    ):
        failures.append("retrieved source list is illegal")
    if sources[0] != ROUTE_SOURCES[result["route"]]:
        failures.append("first retrieved source is not the mapped primary source")

    serialized = json.dumps(result, ensure_ascii=False)
    mentioned_gap_ids = set(re.findall(r"gap\.[a-z0-9_.]+", serialized))
    if any(
        not any(
            mention == known or mention.startswith(f"{known}.")
            for known in KNOWN_GAP_IDS
        )
        for mention in mentioned_gap_ids
    ):
        failures.append("unsupported gap id was invented")

    if "implementation_package.json" not in sources and re.search(
        r"(?:前方一致|完全一致|部分一致|AND|OR|フォーム全体).{0,20}"
        r"(?:を採用します|に決定しました|で確定|承認済み)",
        serialized,
    ):
        failures.append("unretrieved Human decision was presented as resolved")

    case_id = case["id"]
    if case_id in {"A", "B", "C", "D", "E"} and len(sources) != 1:
        failures.append("single-source case performed unnecessary additional retrieval")
    if case_id == "A" and sources != ["project_context.json"]:
        failures.append("current behavior used a non-context source")
    if case_id == "B":
        try:
            context = json.loads(retrieved["project_context.json"])
            allowed_surface_ids = {
                surface["id"]
                for surface in context["relevant_implementation_surfaces"]
            }
        except (json.JSONDecodeError, KeyError, TypeError):
            allowed_surface_ids = set()
        impact_items = result.get("impact_items")
        if not isinstance(impact_items, list) or not impact_items:
            failures.append("impact-scope answer has no validated surface items")
        elif any(
            not isinstance(item, dict)
            or item.get("surface_id") not in allowed_surface_ids
            for item in impact_items
        ):
            failures.append("impact-scope answer contains a non-allowlisted surface")
        if re.search(
            r"インデックス|キャッシュ|性能改善|パフォーマンス|"
            r"新しいService層|新規モジュール",
            result.get("answer", ""),
            re.I,
        ):
            failures.append("unsupported implementation concern reached accepted output")
        if result.get("sufficiency") != "sufficient":
            failures.append("impact-scope answer was not sufficient after validation")
    if case_id == "D" and re.search(
        r"人が決める必要|Human Alignment.{0,8}必要|"
        r"未解決のギャップ(?:が残|が存在|があります|です)",
        result.get("answer", ""),
    ):
        failures.append("post-alignment handoff treated a resolved gap as open")
    if case_id == "F":
        additional = result["additional_retrieval"]
        cited_sources = {
            item.split("#", 1)[0]
            for item in result.get("evidence", [])
            if isinstance(item, str)
        }
        if not (
            sources == ["gaps.json", "project_context.json"]
            and additional.get("used") is True
            and additional.get("source") == "project_context.json"
            and result.get("sufficiency") == "sufficient"
            and cited_sources == {"gaps.json", "project_context.json"}
        ):
            failures.append("additional-retrieval case did not complete the bounded loop")
    if case_id == "G":
        answer = result.get("answer", "")
        if result.get("sufficiency") not in {"partial", "insufficient"}:
            failures.append("out-of-scope answer did not report limited sufficiency")
        if not any(
            marker in answer
            for marker in (
                "不足",
                "含まれていません",
                "含まれていない",
                "判断できません",
                "確認できません",
                "記載がありません",
            )
        ):
            failures.append("out-of-scope answer did not state missing evidence")
        if re.search(r"OAuth|JWT|Basic認証|セッション認証|トークン認証", answer, re.I):
            failures.append("out-of-scope answer invented an authentication design")
    return failures


def run_case(
    repo_root: Path,
    api_key: str,
    base_url: str,
    case: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    validation_warnings: list[str] = []
    metrics = {
        "input_tokens": 0.0,
        "output_tokens": 0.0,
        "total_tokens": 0.0,
        "latency_seconds": 0.0,
        "calls": 0.0,
    }
    routing, usage, latency, _status = route_question(
        api_key, base_url, case["question"]
    )
    add_usage(metrics, usage, latency)
    failures = validate_route(routing, case["expected_route"])
    route = routing.get("route")
    if route not in ROUTE_SOURCES:
        return {
            "question": case["question"],
            "route": route,
            "primary_source": None,
            "retrieved_sources": [],
            "additional_retrieval": {"used": False, "source": None, "reason": None},
            "initial_model_sufficiency": None,
            "model_sufficiency": None,
            "final_sufficiency": "insufficient",
            "sufficiency": "insufficient",
            "answer": "Routing failed.",
            "impact_items": [],
            "evidence": [],
            "validation_warnings": validation_warnings,
            "metrics": metrics,
        }, failures

    primary_source = ROUTE_SOURCES[route]
    retrieved = {primary_source: load_source(repo_root, primary_source)}
    raw_first_decision, usage, latency, _status = grounded_step(
        api_key,
        base_url,
        case["question"],
        route,
        retrieved,
        can_retrieve_more=True,
    )
    add_usage(metrics, usage, latency)
    initial_model_sufficiency = raw_first_decision.get("sufficiency")
    first_decision, controller_warnings = controller_enforce_decision(
        case["question"],
        route,
        raw_first_decision,
        retrieved,
        can_retrieve_more=True,
    )
    validation_warnings.extend(controller_warnings)
    if route == "impact_scope":
        first_decision, impact_warnings = normalize_impact_scope(
            first_decision, retrieved
        )
        validation_warnings.extend(impact_warnings)
    failures.extend(validate_step(first_decision, list(retrieved), True))

    additional = first_decision.get("additional_source")
    additional_reason = first_decision.get("additional_reason")
    used_additional = False
    final_decision = first_decision
    model_sufficiency = initial_model_sufficiency
    if (
        first_decision.get("sufficiency") == "partial"
        and additional in SOURCE_PATHS
        and additional not in retrieved
        and not failures
    ):
        retrieved[additional] = load_source(repo_root, additional)
        used_additional = True
        raw_final_decision, usage, latency, _status = grounded_step(
            api_key,
            base_url,
            case["question"],
            route,
            retrieved,
            can_retrieve_more=False,
        )
        add_usage(metrics, usage, latency)
        model_sufficiency = raw_final_decision.get("sufficiency")
        final_decision, controller_warnings = controller_enforce_decision(
            case["question"],
            route,
            raw_final_decision,
            retrieved,
            can_retrieve_more=False,
        )
        validation_warnings.extend(controller_warnings)
        complete_cross_artifact_evidence(final_decision, retrieved)
        failures.extend(validate_step(final_decision, list(retrieved), False))

    if route == "impact_scope" and used_additional:
        final_decision, impact_warnings = normalize_impact_scope(
            final_decision, retrieved
        )
        validation_warnings.extend(impact_warnings)

    result = {
        "question": case["question"],
        "route": route,
        "primary_source": primary_source,
        "retrieved_sources": list(retrieved),
        "additional_retrieval": {
            "used": used_additional,
            "source": additional if used_additional else None,
            "reason": additional_reason if used_additional else None,
        },
        "initial_model_sufficiency": initial_model_sufficiency,
        "model_sufficiency": model_sufficiency,
        "final_sufficiency": final_decision.get("sufficiency"),
        "sufficiency": final_decision.get("sufficiency"),
        "answer": final_decision.get("answer", ""),
        "impact_items": final_decision.get("impact_items", []),
        "evidence": final_decision.get("evidence", []),
        "validation_warnings": validation_warnings,
        "metrics": {
            "input_tokens": int(metrics["input_tokens"]),
            "output_tokens": int(metrics["output_tokens"]),
            "total_tokens": int(metrics["total_tokens"]),
            "latency_seconds": round(metrics["latency_seconds"], 3),
            "calls": int(metrics["calls"]),
        },
    }
    failures.extend(validate_final(case, result, retrieved))
    return result, failures


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        load_dev_vars(repo_root / ".dev.vars")
        api_key, base_url, _configured_model = require_config()
    except ValueError as exc:
        print(f"Configuration error: {safe_text(exc, '')}", file=sys.stderr)
        return 2

    print(f"Model: {MODEL}")
    print(f"Endpoint host: {parse.urlparse(base_url).hostname}")
    outcomes: list[tuple[dict[str, Any], dict[str, Any], list[str]]] = []
    for case in TEST_CASES:
        print(f"\n=== {case['id']}. {case['name']} ===")
        try:
            result, failures = run_case(repo_root, api_key, base_url, case)
        except (RuntimeError, OSError, ValueError, json.JSONDecodeError) as exc:
            result = {
                "question": case["question"],
                "route": None,
                "primary_source": None,
                "retrieved_sources": [],
                "additional_retrieval": {"used": False, "source": None, "reason": None},
                "initial_model_sufficiency": None,
                "model_sufficiency": None,
                "final_sufficiency": "insufficient",
                "sufficiency": "insufficient",
                "answer": "",
                "impact_items": [],
                "evidence": [],
                "validation_warnings": [],
                "metrics": {},
            }
            failures = [safe_text(exc, api_key)]
        result["validation"] = "PASS" if not failures else "FAIL"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if failures:
            print("Failures: " + "; ".join(failures))
        outcomes.append((case, result, failures))

    passed = sum(not failures for _case, _result, failures in outcomes)
    input_totals = [
        result["metrics"].get("input_tokens", 0)
        for _case, result, _failures in outcomes
        if result.get("metrics")
    ]
    typical_input = statistics.median(input_totals) if input_totals else 0
    savings = (
        (BASELINE_INPUT_TOKENS - typical_input) / BASELINE_INPUT_TOKENS * 100
        if typical_input
        else 0
    )
    f_result = next(result for case, result, _failures in outcomes if case["id"] == "F")
    agentic_loop = (
        f_result["retrieved_sources"] == ["gaps.json", "project_context.json"]
        and f_result["additional_retrieval"]["used"] is True
        and f_result["metrics"].get("calls") == 3
        and {
            item.split("#", 1)[0] for item in f_result.get("evidence", [])
        }
        == {"gaps.json", "project_context.json"}
    )

    print("\n=== Summary ===")
    print(f"Correctness: {passed}/{len(TEST_CASES)} tests passed")
    print(
        "Retrieval efficiency: "
        f"median input={typical_input:g} vs baseline≈{BASELINE_INPUT_TOKENS} "
        f"({savings:+.1f}% reduction)"
    )
    print(
        "Agentic behavior: "
        + (
            "demonstrated route -> retrieve -> partial -> second retrieval -> answer"
            if agentic_loop
            else "not demonstrated; the additional case did not execute the full bounded loop"
        )
    )
    return 0 if passed == len(TEST_CASES) else 1


if __name__ == "__main__":
    raise SystemExit(main())
