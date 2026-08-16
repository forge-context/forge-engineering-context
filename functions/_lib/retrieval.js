import {
  DEFAULT_REQUIREMENT_ID,
  REQUIREMENT_ARTIFACT_NAMES,
  REQUIREMENTS,
  SHARED_ARTIFACTS,
} from "./artifacts.generated.js";
import { MalformedModelResponseError } from "./bailian.js";

// Bump whenever ROUTER_SYSTEM, SYNTHESIS_SYSTEM, or the deterministic controller
// changes: it is a cache-key input, so a stale value would serve outdated answers.
export const PROMPT_VERSION = "retrieval-routing-v0.3/controller-v0.2";

export const ROUTE_SOURCES = Object.freeze({
  current_behavior: "project_context.json",
  impact_scope: "project_context.json",
  human_decision: "gaps.json",
  implementation_handoff: "implementation_package.json",
  forge_design: "architecture.md",
});

const ALLOWED_SUFFICIENCY = new Set(["sufficient", "partial", "insufficient"]);
// Every requirement exposes the same source names, so the allowlist is requirement
// independent even though the content behind each name is not.
const SOURCE_NAMES = new Set([...REQUIREMENT_ARTIFACT_NAMES, ...Object.keys(SHARED_ARTIFACTS)]);

export function isKnownRequirement(requirementId) {
  return Object.hasOwn(REQUIREMENTS, String(requirementId ?? ""));
}

// Resolves the retrievable set for one requirement: its own artifacts plus the
// shared ones. Nothing outside this map can be cited by an answer.
export function artifactsFor(requirementId) {
  const requirement = REQUIREMENTS[requirementId];
  if (!requirement) throw new Error(`unknown requirement: ${requirementId}`);
  return { ...requirement.artifacts, ...SHARED_ARTIFACTS };
}

// Narrows the reported open decisions when a question clearly targets one of them.
// Kept out of the public artifacts: this is a presentation heuristic, not evidence.
const GAP_FOCUS = {
  "owner-city-search": [
    { gapId: "gap.city_matching_semantics", pattern: /(city|市区町村).*(照合|一致)|照合.*(city|市区町村)/i },
  ],
  "same-day-visit": [
    { gapId: "gap.past_date_policy", pattern: /(過去日|過去の日付|past date)/i },
    { gapId: "gap.default_visit_date", pattern: /(初期日付|初期値|既定値|デフォルト|default date)/i },
  ],
};

function focusGaps(requirementId, question, gaps) {
  for (const { gapId, pattern } of GAP_FOCUS[requirementId] || []) {
    if (pattern.test(question)) return gaps.filter((gap) => gap.id === gapId);
  }
  return gaps;
}

// Only blocking Human-authority decisions live in `gaps`. Non-blocking verifications
// and derived implementation impact are separate arrays and are never reported as
// decisions awaiting a human.
function openGaps(artifacts) {
  return (artifacts["gaps.json"].gaps || []).filter((gap) => gap.status === "open" && gap.resolution == null);
}

function addUsage(total, call) {
  total.inputTokens += Number(call.usage?.inputTokens || 0);
  total.outputTokens += Number(call.usage?.outputTokens || 0);
  total.totalTokens += Number(call.usage?.totalTokens || 0);
  total.latencyMs += Number(call.latencyMs || 0);
  total.calls += 1;
}

const ROUTER_SYSTEM = `Classify one Ask Forge question into exactly one route and return only JSON.
Routes and fixed primary sources:
- current_behavior -> project_context.json: current implementation behavior
- impact_scope -> project_context.json: evidenced affected files, layers, or surfaces
- human_decision -> gaps.json: unresolved pre-alignment decisions or why Forge did not decide them
- implementation_handoff -> implementation_package.json: approved post-alignment Coding Agent handoff
- forge_design -> architecture.md: Forge principles or architecture
Choose the closest route. Never name another file.
JSON: {"route":"one route","primary_source":"mapped filename","reason":"short string"}`;

const SYNTHESIS_SYSTEM = `You are the bounded, grounded Ask Forge answer step. Return only JSON.
Use only retrieved artifacts supplied by the user. Never use general Spring PetClinic knowledge, invent context or gaps, close Human-authority gaps, or present candidate options as approved. Keep current behavior distinct from the Human-approved target.
Only entries under "gaps" await a Human decision. Entries under "non_blocking_verifications" and "derived_implementation_impact" are not Human decisions and must never be reported as blocking.

Sufficiency: sufficient when evidence answers the question; partial only when exactly one allowlisted source can supply specifically missing evidence; insufficient when the evidence cannot support the requested answer. Explicitly state missing context.
additional_source and additional_reason are non-null only for partial. For impact_scope, provide exact retrieved surface_id values in impact_items. Evidence entries use retrieved_filename#artifact-locator. Never cite an unretrieved source. Keep Japanese concise.
JSON: {"sufficiency":"sufficient|partial|insufficient","answer":"string","impact_items":[{"surface_id":"exact id","reason":"string"}],"evidence":["string"],"additional_source":null,"additional_reason":null}`;

function artifactText(artifacts, name) {
  const artifact = artifacts[name];
  return typeof artifact === "string" ? artifact : JSON.stringify(artifact);
}

function validateRouting(value) {
  const route = value?.route;
  if (!ROUTE_SOURCES[route] || value.primary_source !== ROUTE_SOURCES[route]) {
    throw new MalformedModelResponseError();
  }
  return route;
}

function validateDecision(value, retrieved, canRetrieveMore) {
  if (!value || !ALLOWED_SUFFICIENCY.has(value.sufficiency) || typeof value.answer !== "string") {
    throw new MalformedModelResponseError();
  }
  if (!Array.isArray(value.evidence) || value.evidence.some((item) => typeof item !== "string")) {
    throw new MalformedModelResponseError();
  }
  if (value.sufficiency !== "partial" && value.evidence.length === 0) {
    throw new MalformedModelResponseError();
  }
  for (const citation of value.evidence) {
    if (!retrieved.includes(citation.split("#", 1)[0])) throw new MalformedModelResponseError();
  }
  const additional = value.additional_source;
  if (value.sufficiency === "partial" && additional != null) {
    if (!canRetrieveMore || !SOURCE_NAMES.has(additional) || retrieved.includes(additional)) {
      throw new MalformedModelResponseError();
    }
    if (typeof value.additional_reason !== "string" || !value.additional_reason.trim()) {
      throw new MalformedModelResponseError();
    }
  } else if (additional != null || value.additional_reason != null) {
    throw new MalformedModelResponseError();
  }
}

function normalizeHumanDecision(requirementId, artifacts, question, decision, retrieved) {
  const gaps = focusGaps(requirementId, question, openGaps(artifacts));
  if (!gaps.length) return decision;
  const asksWhy = /(なぜ|why)/i.test(question);
  const evidence = gaps.map((gap) => `gaps.json#${gap.id}`);
  let answer;
  if (asksWhy && gaps.length === 1) {
    const gap = gaps[0];
    answer = `${gap.why_not_resolved_automatically} 候補は記録されていますが、Human decision がないため Forge はいずれも選択しません。`;
    const reference = gap.observed_existing_behavior?.evidence_ref;
    if (reference && retrieved.includes(reference.split("#", 1)[0])) evidence.push(reference);
  } else {
    answer = `実装前に Human authority で決める必要がある未解決事項は次の ${gaps.length} 件です。\n${gaps.map((gap) => `- ${gap.question}`).join("\n")}`;
  }
  return {
    ...decision,
    sufficiency: "sufficient",
    answer,
    evidence,
    impact_items: [],
    additional_source: null,
    additional_reason: null,
  };
}

function explicitEvidenceSource(artifacts, question, route, retrieved) {
  if (route !== "human_decision" || !/(なぜ|why)/i.test(question) || retrieved.length !== 1) return null;
  const references = new Set(
    (artifacts["gaps.json"]?.gaps || [])
      .map((gap) => gap.observed_existing_behavior?.evidence_ref?.split("#", 1)[0])
      .filter((name) => SOURCE_NAMES.has(name) && !retrieved.includes(name)),
  );
  return references.size === 1 ? [...references][0] : null;
}

function enforceController(artifacts, question, route, raw, retrieved, canRetrieveMore) {
  const decision = { ...raw };
  const warnings = [];
  const required = explicitEvidenceSource(artifacts, question, route, retrieved);
  if (required && canRetrieveMore) {
    if (raw.sufficiency !== "partial" || raw.additional_source !== required) {
      warnings.push(`followed explicit evidence_ref to ${required}`);
    }
    Object.assign(decision, {
      sufficiency: "partial",
      answer: "",
      additional_source: required,
      additional_reason: "The gap explicitly references the observed convention needed by the answer.",
    });
  }

  const explicitMissing = /(?:提供された|取得した|この資料|このアーティファクト|supplied).{0,100}(?:含まれてい|記載されてい|証拠.{0,20}不足|情報.{0,20}不足|回答でき)/i.test(decision.answer);
  if (explicitMissing && decision.sufficiency !== "insufficient") {
    warnings.push(`changed sufficiency from ${decision.sufficiency} to insufficient`);
    decision.sufficiency = "insufficient";
    decision.additional_source = null;
    decision.additional_reason = null;
  }
  return { decision, warnings };
}

function normalizeImpact(artifacts, decision) {
  const warnings = [];
  const surfaces = artifacts["project_context.json"].relevant_implementation_surfaces || [];
  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  const selected = [];
  for (const item of Array.isArray(decision.impact_items) ? decision.impact_items : []) {
    if (!item || !byId.has(item.surface_id)) {
      warnings.push(`removed unsupported impact surface: ${item?.surface_id || "malformed"}`);
      continue;
    }
    if (!selected.includes(item.surface_id)) selected.push(item.surface_id);
  }
  if (!selected.length) {
    for (const citation of decision.evidence) {
      const id = citation.startsWith("project_context.json#") ? citation.split("#", 2)[1] : "";
      if (byId.has(id) && !selected.includes(id)) selected.push(id);
    }
  }
  const impactItems = selected.map((surfaceId) => ({
    surface_id: surfaceId,
    reason: byId.get(surfaceId).description,
  }));
  if (!impactItems.length) {
    return {
      decision: {
        ...decision,
        sufficiency: "insufficient",
        answer: "取得した Project Context から裏付けられた影響範囲を特定できませんでした。",
        evidence: ["project_context.json#relevant_implementation_surfaces"],
        impact_items: [],
        additional_source: null,
        additional_reason: null,
      },
      warnings: [...warnings, "no allowlisted impact surface remained"],
    };
  }
  return {
    decision: {
      ...decision,
      sufficiency: "sufficient",
      answer: impactItems.map((item) => `- ${item.surface_id}: ${item.reason}`).join("\n"),
      evidence: impactItems.map((item) => `project_context.json#${item.surface_id}`),
      impact_items: impactItems,
      additional_source: null,
      additional_reason: null,
    },
    warnings,
  };
}

function completeCrossEvidence(artifacts, decision, retrieved) {
  if (!retrieved.includes("gaps.json") || !retrieved.includes("project_context.json")) return;
  const gaps = artifacts["gaps.json"].gaps || [];
  for (const citation of [...decision.evidence]) {
    const locator = citation.startsWith("gaps.json#") ? citation.slice("gaps.json#".length) : "";
    const gap = gaps.find((item) => locator === item.id || locator.startsWith(`${item.id}.`));
    const reference = gap?.observed_existing_behavior?.evidence_ref;
    if (reference && !decision.evidence.includes(reference)) decision.evidence.push(reference);
  }
}

function humanAuthority(requirementId, artifacts, route, question) {
  if (route !== "human_decision") return [];
  return focusGaps(requirementId, question, openGaps(artifacts)).map((gap) => ({
    gap_id: gap.id,
    topic: gap.question,
    status: "open",
    candidate_options: (gap.candidate_options || []).map((item) => item.option),
  }));
}

async function groundedStep(client, artifacts, question, route, retrieved, canRetrieveMore) {
  const remaining = Object.keys(artifacts).filter((name) => !retrieved.includes(name));
  const retrievalRule = canRetrieveMore
    ? `You may request exactly one remaining source: ${remaining.join(", ")}.`
    : "No more retrieval is allowed; additional_source and additional_reason must be null.";
  const blocks = retrieved.map((name) => `--- ${name} ---\n${artifactText(artifacts, name)}`).join("\n\n");
  return client.complete({
    maxTokens: 600,
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM },
      {
        role: "user",
        content: `Question:\n${question}\n\nRoute: ${route}\n${retrievalRule}\n\nRetrieved artifacts:\n${blocks}\n\nReturn JSON.`,
      },
    ],
  });
}

export async function runRetrieval(question, client, requirementId = DEFAULT_REQUIREMENT_ID) {
  const artifacts = artifactsFor(requirementId);
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, calls: 0 };
  const progress = {
    questionType: null,
    route: null,
    primarySource: null,
    additionalSource: null,
    additionalReason: null,
    modelSufficiency: null,
  };
  try {
    const routed = await client.complete({
      maxTokens: 160,
      messages: [
        { role: "system", content: ROUTER_SYSTEM },
        { role: "user", content: `Question:\n${question}\nReturn JSON.` },
      ],
    });
    addUsage(usage, routed);
    const route = validateRouting(routed.result);
    const primarySource = ROUTE_SOURCES[route];
    const retrieved = [primarySource];
    Object.assign(progress, { questionType: route, route, primarySource });

    const first = await groundedStep(client, artifacts, question, route, retrieved, true);
    addUsage(usage, first);
    validateDecision(first.result, retrieved, true);
    const initialModelSufficiency = first.result.sufficiency;
    progress.modelSufficiency = initialModelSufficiency;
    let { decision, warnings } = enforceController(artifacts, question, route, first.result, retrieved, true);
    if (route === "impact_scope") {
      const normalized = normalizeImpact(artifacts, decision);
      decision = normalized.decision;
      warnings.push(...normalized.warnings);
    }

    let additionalSource = null;
    let additionalReason = null;
    let modelSufficiency = initialModelSufficiency;
    if (decision.sufficiency === "partial" && decision.additional_source && retrieved.length === 1) {
      additionalSource = decision.additional_source;
      additionalReason = decision.additional_reason;
      Object.assign(progress, { additionalSource, additionalReason });
      retrieved.push(additionalSource);
      const second = await groundedStep(client, artifacts, question, route, retrieved, false);
      addUsage(usage, second);
      validateDecision(second.result, retrieved, false);
      modelSufficiency = second.result.sufficiency;
      const enforced = enforceController(artifacts, question, route, second.result, retrieved, false);
      decision = enforced.decision;
      warnings.push(...enforced.warnings);
      completeCrossEvidence(artifacts, decision, retrieved);
    }

    if (route === "human_decision") {
      decision = normalizeHumanDecision(requirementId, artifacts, question, decision, retrieved);
    }

    return {
      requirementId,
      questionType: route,
      route,
      primarySource,
      additionalSource,
      additionalReason,
      retrievedSources: retrieved,
      initialModelSufficiency,
      modelSufficiency,
      finalSufficiency: decision.sufficiency,
      answer: decision.answer,
      evidence: decision.evidence,
      impactItems: decision.impact_items || [],
      humanAuthority: humanAuthority(requirementId, artifacts, route, question),
      guardrailsTriggered: warnings.length ? ["deterministic_controller"] : [],
      validationWarnings: warnings,
      usage,
    };
  } catch (error) {
    error.usage = usage;
    error.retrievalTrace = progress;
    throw error;
  }
}
