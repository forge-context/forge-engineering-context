#!/usr/bin/env python3
"""Run two local Ask Forge grounded-synthesis checks against fixed artifacts."""

from __future__ import annotations

import json
import re
import socket
import ssl
import sys
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
ALLOWED_SOURCES = {"project_context.json", "gaps.json"}
ALLOWED_SUFFICIENCY = {"sufficient", "partial", "insufficient"}
POSITIVE_QUESTION = "この要件で、実装前に人が決める必要があることは何ですか？"
NEGATIVE_QUESTION = "この要件では認証方式をどう変更すべきですか？"

SYSTEM_PROMPT = """You are the Ask Forge v0.1 grounded-synthesis verifier.
Return exactly one valid JSON object and no Markdown or surrounding text.

Grounding rules:
1. Answer only from the two artifacts supplied in the user message.
2. Do not use general knowledge about Spring PetClinic.
3. Do not invent additional Context Gaps.
4. Do not select, recommend, or present a candidate option as resolved unless an artifact records a Human decision.
5. Clearly separate known evidence/context in `answer` from unresolved Human-authority decisions in `human_authority_required`.
6. If the artifacts lack evidence for any part of the question, state that explicitly.
7. Cite only project_context.json and gaps.json.
8. `topic` must be an exact gap `id` from gaps.json. A missing topic must not be turned into a new gap; use an empty list and mark the answer partial or insufficient.
9. `candidate_options` may contain only exact `option` strings from the matching gap.
10. `evidence` may contain only `gaps.json#<gap-id>` and that gap's exact `observed_existing_behavior.evidence_ref`.
11. `sufficiency` describes whether the supplied artifacts are enough to answer the question, not whether the open Human decision itself has been resolved.

Use this JSON shape:
{
  "answer": "string",
  "human_authority_required": [
    {
      "topic": "exact gap id",
      "reason": "string",
      "candidate_options": ["exact artifact option"],
      "evidence": ["exact artifact reference"]
    }
  ],
  "sufficiency": "sufficient | partial | insufficient",
  "sources": ["project_context.json", "gaps.json"]
}
Keep the Japanese answer concise."""


def load_artifacts(repo_root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    example_dir = repo_root / "examples" / "petclinic"
    with (example_dir / "project_context.json").open(encoding="utf-8") as handle:
        project_context = json.load(handle)
    with (example_dir / "gaps.json").open(encoding="utf-8") as handle:
        gaps = json.load(handle)
    return project_context, gaps


def build_user_prompt(
    question: str, project_context: dict[str, Any], gaps: dict[str, Any]
) -> str:
    compact = lambda value: json.dumps(
        value, ensure_ascii=False, separators=(",", ":")
    )
    return (
        f"Question:\n{question}\n\n"
        "Supplied artifacts (the only allowed evidence):\n"
        f"project_context.json:\n{compact(project_context)}\n\n"
        f"gaps.json:\n{compact(gaps)}\n\n"
        "Return the grounded result as JSON."
    )


def call_model(
    api_key: str,
    base_url: str,
    question: str,
    project_context: dict[str, Any],
    gaps: dict[str, Any],
) -> tuple[str, dict[str, Any], int]:
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": build_user_prompt(question, project_context, gaps),
                },
            ],
            "temperature": 0.1,
            "max_tokens": 800,
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

    try:
        api_response = json.loads(response_body.decode("utf-8"))
        assistant_text = api_response["choices"][0]["message"]["content"]
        if not isinstance(assistant_text, str):
            raise TypeError
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
        raise RuntimeError("API returned an unexpected response shape") from None

    usage = api_response.get("usage", {})
    return assistant_text, usage if isinstance(usage, dict) else {}, status


def validate_common(result: Any, gaps_artifact: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if not isinstance(result, dict):
        return ["top-level response is not a JSON object"]

    required_fields = {
        "answer",
        "human_authority_required",
        "sufficiency",
        "sources",
    }
    missing_fields = required_fields - result.keys()
    if missing_fields:
        failures.append(f"missing fields: {', '.join(sorted(missing_fields))}")

    if not isinstance(result.get("answer"), str) or not result.get("answer", "").strip():
        failures.append("answer must be a non-empty string")
    if result.get("sufficiency") not in ALLOWED_SUFFICIENCY:
        failures.append("sufficiency is not an allowed value")

    sources = result.get("sources")
    if not isinstance(sources, list) or any(not isinstance(item, str) for item in sources):
        failures.append("sources must be a string array")
    elif set(sources) != ALLOWED_SOURCES:
        failures.append("sources must contain exactly the two supplied artifacts")

    gaps_by_id = {
        gap["id"]: gap
        for gap in gaps_artifact.get("gaps", [])
        if isinstance(gap, dict) and isinstance(gap.get("id"), str)
    }
    returned = result.get("human_authority_required")
    if not isinstance(returned, list):
        failures.append("human_authority_required must be an array")
        return failures

    for index, item in enumerate(returned):
        label = f"human_authority_required[{index}]"
        if not isinstance(item, dict):
            failures.append(f"{label} is not an object")
            continue
        topic = item.get("topic")
        if topic not in gaps_by_id:
            failures.append(f"{label}.topic is not a supplied gap id")
            continue

        source_gap = gaps_by_id[topic]
        if source_gap.get("status") != "open" or source_gap.get("resolution") is not None:
            failures.append(f"{label} is not backed by an open, unresolved gap")
        if not isinstance(item.get("reason"), str) or not item.get("reason", "").strip():
            failures.append(f"{label}.reason must be a non-empty string")

        candidate_options = item.get("candidate_options")
        allowed_options = {
            candidate["option"]
            for candidate in source_gap.get("candidate_options", [])
            if isinstance(candidate, dict) and isinstance(candidate.get("option"), str)
        }
        if not isinstance(candidate_options, list) or any(
            not isinstance(option, str) for option in candidate_options
        ):
            failures.append(f"{label}.candidate_options must be a string array")
        elif not set(candidate_options).issubset(allowed_options):
            failures.append(f"{label}.candidate_options contains an unsupported option")

        evidence = item.get("evidence")
        allowed_evidence = {f"gaps.json#{topic}"}
        observed = source_gap.get("observed_existing_behavior", {})
        if isinstance(observed, dict) and isinstance(observed.get("evidence_ref"), str):
            allowed_evidence.add(observed["evidence_ref"])
        if not isinstance(evidence, list) or any(
            not isinstance(reference, str) for reference in evidence
        ):
            failures.append(f"{label}.evidence must be a string array")
        elif not evidence or not set(evidence).issubset(allowed_evidence):
            failures.append(f"{label}.evidence contains an unsupported reference")

    serialized = json.dumps(result, ensure_ascii=False)
    resolved_claims = (
        r"を推奨します|が推奨される|を採用します|に決定しました|"
        r"決定済み|確定済み|選択済み|"
        r"has been (?:selected|decided|resolved)|is the recommended option"
    )
    if re.search(resolved_claims, serialized, flags=re.IGNORECASE):
        failures.append("response presents or recommends an unresolved Human decision")

    topics = [item.get("topic") for item in returned if isinstance(item, dict)]
    if len(topics) != len(set(topics)):
        failures.append("response repeats a gap topic")
    return failures


def validate_positive(result: Any, gaps_artifact: dict[str, Any]) -> list[str]:
    failures = validate_common(result, gaps_artifact)
    if not isinstance(result, dict):
        return failures
    expected_topics = {
        gap["id"]
        for gap in gaps_artifact.get("gaps", [])
        if isinstance(gap, dict)
        and gap.get("type") == "human_authority_decision"
        and gap.get("status") == "open"
        and gap.get("resolution") is None
    }
    returned = result.get("human_authority_required", [])
    actual_topics = {
        item.get("topic") for item in returned if isinstance(item, dict)
    }
    if actual_topics != expected_topics:
        failures.append("returned topics do not exactly match the supplied open gaps")
    return failures


def validate_negative(result: Any, gaps_artifact: dict[str, Any]) -> list[str]:
    failures = validate_common(result, gaps_artifact)
    if not isinstance(result, dict):
        return failures
    if result.get("sufficiency") not in {"partial", "insufficient"}:
        failures.append("negative control must be partial or insufficient")
    if result.get("human_authority_required") != []:
        failures.append("negative control invented an authentication-related gap")
    answer = result.get("answer", "")
    if isinstance(answer, str):
        has_auth_subject = "認証" in answer or "authentication" in answer.lower()
        has_insufficiency = any(
            marker in answer
            for marker in ("不足", "含まれていません", "含まれていない", "判断できません", "確認できません", "記録されていません")
        )
        if not has_auth_subject or not has_insufficiency:
            failures.append("negative answer does not explicitly state missing authentication evidence")
    return failures


def print_case(
    label: str,
    question: str,
    assistant_text: str,
    result: Any,
    usage: dict[str, Any],
    status: int,
    failures: list[str],
) -> None:
    print(f"\n=== {label} ===")
    print(f"Question: {question}")
    print(f"HTTP status: {status}")
    print("Response:")
    if isinstance(result, dict):
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(assistant_text)
    prompt_tokens = usage.get("prompt_tokens", usage.get("input_tokens"))
    completion_tokens = usage.get("completion_tokens", usage.get("output_tokens"))
    total_tokens = usage.get("total_tokens")
    print(
        "Token usage: "
        f"input={prompt_tokens}, output={completion_tokens}, total={total_tokens}"
    )
    if failures:
        print(f"Validation: FAIL ({'; '.join(failures)})")
    else:
        print("Validation: PASS")


def run_case(
    label: str,
    question: str,
    api_key: str,
    base_url: str,
    project_context: dict[str, Any],
    gaps: dict[str, Any],
    validator: Any,
) -> bool:
    assistant_text, usage, status = call_model(
        api_key, base_url, question, project_context, gaps
    )
    try:
        result = json.loads(assistant_text)
        failures = validator(result, gaps)
    except json.JSONDecodeError:
        result = None
        failures = ["assistant response is not valid JSON"]
    print_case(label, question, assistant_text, result, usage, status, failures)
    return not failures


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        load_dev_vars(repo_root / ".dev.vars")
        api_key, base_url, _configured_model = require_config()
        project_context, gaps = load_artifacts(repo_root)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"Configuration/artifact error: {safe_text(exc, '')}", file=sys.stderr)
        return 2

    print(f"Model: {MODEL}")
    print(f"Endpoint host: {parse.urlparse(base_url).hostname}")
    try:
        positive_passed = run_case(
            "positive grounded test",
            POSITIVE_QUESTION,
            api_key,
            base_url,
            project_context,
            gaps,
            validate_positive,
        )
        if not positive_passed:
            print("\nOverall: FAIL (negative control was not run)")
            return 1
        negative_passed = run_case(
            "negative control",
            NEGATIVE_QUESTION,
            api_key,
            base_url,
            project_context,
            gaps,
            validate_negative,
        )
    except RuntimeError as exc:
        print(f"Test error: {safe_text(exc, api_key)}", file=sys.stderr)
        return 1

    print(f"\nOverall: {'PASS' if negative_passed else 'FAIL'}")
    return 0 if negative_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
