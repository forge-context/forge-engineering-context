import test from "node:test";
import assert from "node:assert/strict";

import { handleAskRequest } from "../functions/_lib/service.js";
import { runRetrieval } from "../functions/_lib/retrieval.js";
import { artifactsFor } from "../functions/_lib/retrieval.js";
import { citationSupported, locatorExists, splitCitation } from "../functions/_lib/locator.js";

// Reliability regressions promoted from the Step 4A retrieval pressure test.
// Every case here was observed against the real pipeline before it was fixed:
// C9 and the freshness questions failed the whole request, and C2, C3, C7 and
// C8 returned HTTP 200 with evidence or impact surfaces that do not exist.

const ENV = {
  BAILIAN_API_KEY: "test-secret-never-log",
  BAILIAN_BASE_URL: "https://example.invalid/compatible-mode/v1",
  BAILIAN_MODEL: "qwen3.7-plus",
  CLIENT_HASH_SALT: "test-salt",
};

const SAFE_INSUFFICIENT = "取得した Artifact だけでは、この質問に十分な根拠を確認できませんでした。";
const MODEL_ANSWER = "現在の飼い主検索は姓の前方一致で動作します。";

function makeStore() {
  const audit = [];
  return {
    audit,
    async consumeClientRate() {
      return { ok: true };
    },
    async reserveGlobalBudget() {
      return { ok: true };
    },
    async reconcileGlobalBudget() {},
    async writeAudit(trace) {
      audit.push(structuredClone(trace));
    },
  };
}

const noCache = { async read() { return null; }, async write() {} };

function scriptedClient(results) {
  let index = 0;
  return {
    get calls() {
      return index;
    },
    async complete() {
      const result = results[index++];
      return { result, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, latencyMs: 1 };
    },
  };
}

// One grounded response, exactly as the Step 4A suite C harness scripted it.
function synthesis(overrides = {}) {
  return {
    sufficiency: "sufficient",
    answer: MODEL_ANSWER,
    impact_items: [],
    evidence: [],
    additional_source: null,
    additional_reason: null,
    ...overrides,
  };
}

async function ask({ route, source, synthesis: result, requirementId = "owner-city-search", question = "現在の飼い主検索はどう動いていますか？" }) {
  const store = makeStore();
  const client = scriptedClient([{ route, primary_source: source, reason: "scripted" }, result]);
  const request = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
    body: JSON.stringify({ requirement_id: requirementId, question }),
  });
  const response = await handleAskRequest(request, ENV, { store, client, cache: noCache, requestId: "req-test" });
  return {
    status: response.status,
    body: await response.json(),
    trace: store.audit[store.audit.length - 1] || {},
    calls: client.calls,
  };
}

// --- R1: recoverable contract normalization -------------------------------
// Step 4A case C9, and the shape behind all three freshness questions: an
// honest `insufficient` that also names the source that would have helped.

test("R1 insufficient paired with an additional source is normalized, not failed", async () => {
  const result = await ask({
    route: "forge_design",
    source: "architecture.md",
    synthesis: synthesis({
      sufficiency: "insufficient",
      answer: "この Context は最新のリポジトリと一致しています。",
      evidence: ["architecture.md#retrieval"],
      additional_source: "project_context.json",
      additional_reason: "この要件の Context が必要です。",
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "insufficient");
  // No additional retrieval: the router call and one grounded call, nothing more.
  assert.equal(result.calls, 2);
  assert.deepEqual(result.body.retrieved_sources, ["architecture.md"]);
  assert.equal(result.trace.additionalSource, null);
  // The model's own answer asserted freshness it could not support, so it is
  // replaced rather than returned.
  assert.equal(result.body.answer, SAFE_INSUFFICIENT);
  assert.ok(result.trace.validationWarnings.some((w) => w.startsWith("normalized_insufficient_contract")));
  assert.ok(result.trace.guardrailsTriggered.includes("recoverable_contract_normalized"));
  assert.equal(result.trace.resultStatus, "insufficient");
});

test("R1 the model sufficiency reported to the audit trail is still the model's own", async () => {
  const result = await ask({
    route: "forge_design",
    source: "architecture.md",
    synthesis: synthesis({
      sufficiency: "insufficient",
      answer: "不足しています。",
      evidence: ["architecture.md#retrieval"],
      additional_source: "gaps.json",
      additional_reason: "未解決事項の確認が必要です。",
    }),
  });
  assert.equal(result.trace.modelSufficiency, "insufficient");
  assert.equal(result.trace.finalSufficiency, "insufficient");
});

test("an insufficient answer carrying only a stray additional_reason is normalized", async () => {
  const result = await ask({
    route: "forge_design",
    source: "architecture.md",
    synthesis: synthesis({
      sufficiency: "insufficient",
      answer: "不足しています。",
      evidence: ["architecture.md#retrieval"],
      additional_source: null,
      additional_reason: "もう一つ資料が必要です。",
    }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "insufficient");
});

test("an insufficient answer that cites nothing is normalized onto the source it checked", async () => {
  // The second freshness phrasing (Step 4A D2b) fails this way rather than on
  // additional_source: `insufficient`, no citation at all, and a named source.
  const result = await ask({
    route: "forge_design",
    source: "architecture.md",
    synthesis: synthesis({
      sufficiency: "insufficient",
      answer: "この Context は 2026 年時点のコードです。",
      evidence: [],
      additional_source: "project_context.json",
      additional_reason: "reference_revision を確認する必要があります。",
    }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "insufficient");
  assert.equal(result.body.answer, SAFE_INSUFFICIENT);
  // architecture.md is prose and carries no resolvable locator, so the citation
  // of last resort comes from the first retrieved artifact that has one.
  assert.equal(result.body.evidence.length, 1);
  assert.ok(result.trace.validationWarnings.some((w) => w.includes("cited no checked source")));
});

test("a sufficient answer with no citation at all stays a hard failure", async () => {
  const result = await ask({
    route: "current_behavior",
    source: "project_context.json",
    synthesis: synthesis({ evidence: [] }),
  });
  assert.equal(result.status, 502);
});

test("normalization never widens into the ambiguous or unknown cases", async () => {
  // `sufficient` while asking for more evidence is self-contradictory.
  const contradictory = await ask({
    route: "forge_design",
    source: "architecture.md",
    synthesis: synthesis({
      evidence: ["architecture.md#retrieval"],
      additional_source: "project_context.json",
      additional_reason: "念のため。",
    }),
  });
  assert.equal(contradictory.status, 502);

  // A source name outside the allowlist is not a source at all.
  const unknown = await ask({
    route: "forge_design",
    source: "architecture.md",
    synthesis: synthesis({
      sufficiency: "insufficient",
      evidence: ["architecture.md#retrieval"],
      additional_source: "../../etc/passwd",
      additional_reason: "必要です。",
    }),
  });
  assert.equal(unknown.status, 502);

  // Citing a file that was never retrieved stays a hard failure (Step 4A C5).
  const unretrieved = await ask({
    route: "current_behavior",
    source: "project_context.json",
    synthesis: synthesis({ evidence: ["gaps.json#gap.city_matching_semantics"] }),
  });
  assert.equal(unretrieved.status, 502);
});

// --- R2-R4: locator existence --------------------------------------------

async function citing(evidence, extra = {}) {
  return ask({
    route: "current_behavior",
    source: "project_context.json",
    synthesis: synthesis({ evidence, ...extra }),
  });
}

test("R2 a nonexistent locator is not silently accepted", async () => {
  const result = await citing(["project_context.json#surface.does_not_exist"]);
  assert.equal(result.status, 200);
  assert.ok(!result.body.evidence.includes("project_context.json#surface.does_not_exist"));
  assert.equal(result.body.sufficiency, "insufficient");
  assert.equal(result.body.answer, SAFE_INSUFFICIENT);
  assert.ok(result.trace.validationWarnings.some((w) => w.includes("surface.does_not_exist")));
});

test("R3 a locator that exists only in another requirement is not silently accepted", async () => {
  // A real Outline surface id, cited against the PetClinic artifact instance
  // that shares the filename.
  const result = await citing(["project_context.json#surface.command.document_restorer"]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.evidence, ["project_context.json#relevant_implementation_surfaces"]);
  assert.equal(result.body.sufficiency, "insufficient");
});

test("R4 a locator indexing past the end of a real array is not silently accepted", async () => {
  const result = await ask({
    route: "implementation_handoff",
    source: "implementation_package.json",
    synthesis: synthesis({ evidence: ["implementation_package.json#human_decisions[9].decision.matching"] }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.evidence.length, 1);
  assert.ok(!result.body.evidence[0].includes("[9]"));
  assert.equal(result.body.sufficiency, "insufficient");
});

test("one unresolvable citation among valid ones is dropped without losing the answer", async () => {
  const result = await citing([
    "project_context.json#surface.repository.owner_lookup",
    "project_context.json#surface.does_not_exist",
  ]);
  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "sufficient");
  assert.equal(result.body.answer, MODEL_ANSWER);
  assert.deepEqual(result.body.evidence, ["project_context.json#surface.repository.owner_lookup"]);
  assert.ok(result.trace.validationWarnings.some((w) => w.startsWith("removed unresolvable citation")));
});

test("R7 a valid citation is returned unchanged and warns about nothing", async () => {
  const result = await citing(["project_context.json#surface.repository.owner_lookup"]);
  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "sufficient");
  assert.equal(result.body.answer, MODEL_ANSWER);
  assert.deepEqual(result.body.evidence, ["project_context.json#surface.repository.owner_lookup"]);
  assert.deepEqual(result.trace.validationWarnings, []);
  assert.deepEqual(result.trace.guardrailsTriggered, []);
});

// --- R5-R6: impact_items validation is a property of the answer -----------

const FABRICATED_IMPACT = [{ surface_id: "surface.does_not_exist", reason: "架空の影響範囲" }];

test("R5 a fabricated impact surface is removed on current_behavior too", async () => {
  const result = await citing(["project_context.json#surface.repository.owner_lookup"], {
    impact_items: FABRICATED_IMPACT,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.impact_items, []);
  assert.ok(result.trace.validationWarnings.some((w) => w.includes("removed unsupported impact surface")));
});

test("R6 the same fabricated surface keeps its existing impact_scope behavior", async () => {
  const result = await ask({
    route: "impact_scope",
    source: "project_context.json",
    synthesis: synthesis({
      evidence: ["project_context.json#surface.does_not_exist"],
      impact_items: FABRICATED_IMPACT,
    }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "insufficient");
  assert.deepEqual(result.body.impact_items, []);
  assert.deepEqual(result.body.evidence, ["project_context.json#relevant_implementation_surfaces"]);
  assert.ok(result.trace.validationWarnings.includes("no allowlisted impact surface remained"));
});

test("a real impact surface still survives on a non-impact route", async () => {
  const result = await citing(["project_context.json#surface.repository.owner_lookup"], {
    impact_items: [{ surface_id: "surface.ui.search_form", reason: "検索フォームに入力欄を追加します。" }],
  });
  assert.deepEqual(result.body.impact_items.map((item) => item.surface_id), ["surface.ui.search_form"]);
  assert.deepEqual(result.trace.validationWarnings, []);
});

test("impact surfaces from another requirement are dropped on every route", async () => {
  for (const route of ["current_behavior", "impact_scope", "implementation_handoff"]) {
    const source = route === "implementation_handoff" ? "implementation_package.json" : "project_context.json";
    const result = await ask({
      route,
      source,
      synthesis: synthesis({
        evidence: [`${source}#${route === "implementation_handoff" ? "approved_target" : "surface.repository.owner_lookup"}`],
        // A real surface id, but Outline's.
        impact_items: [{ surface_id: "surface.model.document_restore_to", reason: "他要件の surface" }],
      }),
    });
    assert.equal(result.status, 200, route);
    // impact_scope may still derive an own-project surface from the valid
    // citation, which is its existing behavior; what must never survive is the
    // surface belonging to the other requirement.
    assert.ok(
      !result.body.impact_items.some((item) => item.surface_id === "surface.model.document_restore_to"),
      route,
    );
  }
});

// --- L1-L5: the locator resolver in isolation -----------------------------

const PETCLINIC = artifactsFor("owner-city-search");
const OUTLINE = artifactsFor("outline-restore-nested-documents");

test("L1 every locator shape the current artifacts actually use resolves", () => {
  const cases = [
    // identifier recorded inside the artifact
    ["project_context.json", "surface.repository.owner_lookup"],
    ["gaps.json", "gap.city_matching_semantics"],
    // top-level field
    ["gaps.json", "gaps"],
    ["implementation_package.json", "approved_target"],
    ["implementation_package.json", "artifact_stage"],
    ["project_context.json", "relevant_implementation_surfaces"],
    // path with an array index
    ["project_context.json", "relevant_implementation_surfaces[0].evidence.note"],
    ["implementation_package.json", "human_decisions[0].decision.matching"],
    // path continuing from an identifier
    ["gaps.json", "gap.city_matching_semantics.candidate_options"],
    ["gaps.json", "gap.city_matching_semantics.observed_existing_behavior.evidence_ref"],
    // reference values a package records instead of embedding
    ["implementation_package.json", "surface.ui.search_form"],
  ];
  for (const [file, locator] of cases) {
    assert.equal(locatorExists(PETCLINIC[file], locator), true, `${file}#${locator}`);
  }
});

test("L2 a nonexistent locator does not resolve", () => {
  assert.equal(locatorExists(PETCLINIC["project_context.json"], "surface.does_not_exist"), false);
  assert.equal(locatorExists(PETCLINIC["project_context.json"], "relevant_implementation_surfaces[0].nope"), false);
  assert.equal(locatorExists(PETCLINIC["gaps.json"], "gap.city_matching_semantics.nope"), false);
});

test("L3 a locator from another requirement does not resolve", () => {
  assert.equal(locatorExists(PETCLINIC["project_context.json"], "surface.model.document_restore_to"), false);
  assert.equal(locatorExists(OUTLINE["project_context.json"], "surface.repository.owner_lookup"), false);
  assert.equal(locatorExists(PETCLINIC["gaps.json"], "gap.restore_scope"), false);
  assert.equal(locatorExists(OUTLINE["gaps.json"], "gap.city_matching_semantics"), false);
});

test("L4 an out-of-range or malformed path does not resolve", () => {
  const pkg = PETCLINIC["implementation_package.json"];
  assert.equal(locatorExists(pkg, "human_decisions[9].decision.matching"), false);
  assert.equal(locatorExists(pkg, `human_decisions[${pkg.human_decisions.length}]`), false);
  assert.equal(locatorExists(pkg, "human_decisions[0]"), true);
  assert.equal(locatorExists(pkg, "human_decisions[-1]"), false);
  assert.equal(locatorExists(pkg, "human_decisions..matching"), false);
  assert.equal(locatorExists(pkg, "human_decisions[0].decision[0]"), false);
});

test("L5 a citation without a locator is not a citation", () => {
  // The synthesis contract is `retrieved_filename#artifact-locator`; the file
  // name on its own names no evidence, so it is not accepted as one.
  const artifacts = { "project_context.json": PETCLINIC["project_context.json"] };
  assert.equal(citationSupported(artifacts, ["project_context.json"], "project_context.json"), false);
  assert.equal(citationSupported(artifacts, ["project_context.json"], "project_context.json#"), false);
  assert.equal(citationSupported(artifacts, ["project_context.json"], "project_context.json#   "), false);
  assert.equal(
    citationSupported(artifacts, ["project_context.json"], "project_context.json#surface.ui.search_form"),
    true,
  );
});

test("a citation is only supported when its file was actually retrieved", () => {
  assert.equal(citationSupported(PETCLINIC, [], "project_context.json#surface.ui.search_form"), false);
  assert.equal(citationSupported(PETCLINIC, ["gaps.json"], "project_context.json#surface.ui.search_form"), false);
});

test("a locator may itself contain the separator only after the first one", () => {
  assert.deepEqual(splitCitation("project_context.json#a#b"), { filename: "project_context.json", locator: "a#b" });
  assert.deepEqual(splitCitation("architecture.md"), { filename: "architecture.md", locator: "" });
});

test("Markdown locators are membership checked only, and that limit is deliberate", () => {
  // architecture.md is prose. The current citation contract defines locators
  // over structured artifacts, so existence inside Markdown is not resolvable
  // without inventing an anchor schema — which is a separate contract change.
  assert.equal(locatorExists(PETCLINIC["architecture.md"], "retrieval"), true);
  assert.equal(locatorExists(PETCLINIC["architecture.md"], "anything-at-all"), true);
  assert.equal(locatorExists(PETCLINIC["architecture.md"], ""), false);
});

// --- Cross-project isolation ----------------------------------------------

test("locator validation never crosses between the two reference projects", async () => {
  const outlineLocatorInPetclinic = await citing(["project_context.json#surface.route.document_restore"]);
  assert.equal(outlineLocatorInPetclinic.body.sufficiency, "insufficient");
  assert.ok(!outlineLocatorInPetclinic.body.evidence.some((item) => item.includes("document_restore")));

  const store = makeStore();
  const client = scriptedClient([
    { route: "current_behavior", primary_source: "project_context.json", reason: "scripted" },
    synthesis({ evidence: ["project_context.json#surface.repository.owner_lookup"] }),
  ]);
  const result = await runRetrieval("子文書はどうなりますか？", client, "outline-restore-nested-documents");
  assert.equal(result.finalSufficiency, "insufficient");
  assert.ok(!result.evidence.some((item) => item.includes("owner_lookup")));
  assert.ok(store.audit.length === 0);
});

test("each project's own locators still resolve under its own requirement", async () => {
  const petclinic = await citing(["project_context.json#surface.ui.search_form"]);
  assert.equal(petclinic.body.sufficiency, "sufficient");

  const client = scriptedClient([
    { route: "current_behavior", primary_source: "project_context.json", reason: "scripted" },
    synthesis({ evidence: ["project_context.json#surface.model.document_restore_to"] }),
  ]);
  const outline = await runRetrieval("子文書はどうなりますか？", client, "outline-restore-nested-documents");
  assert.equal(outline.finalSufficiency, "sufficient");
  assert.deepEqual(outline.evidence, ["project_context.json#surface.model.document_restore_to"]);
});
