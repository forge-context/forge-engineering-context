import test from "node:test";
import assert from "node:assert/strict";

import { ROUTER_SYSTEM, ROUTE_SOURCES, runRetrieval } from "../functions/_lib/retrieval.js";

// Routing is a model step, so these tests lock the two things that can be checked
// without the model: the semantic contract the router is given, and what the rest
// of the pipeline does once a question has been routed. The live routing itself is
// covered by the qualification records under docs/evaluation.

// A second reference project exposed this boundary: a question about the target
// application's unresolved authority ("how are differing permissions handled?") was
// classified as a question about Forge's own design. The fix is a subject rule, so
// the subject rule is what is guarded here.
test("the router contract separates the target application from Forge itself", () => {
  assert.match(ROUTER_SYSTEM, /First decide the subject/);
  // human_decision must cover authority and policy questions, not only "what is undecided".
  const humanDecision = ROUTER_SYSTEM.match(/^- human_decision ->.*$/m)?.[0];
  assert.ok(humanDecision, "the router contract must describe human_decision");
  for (const term of ["policy", "scope", "options", "authority", "current requirement"]) {
    assert.ok(humanDecision.includes(term), `human_decision must mention ${term}`);
  }
  // forge_design must be scoped to Forge, not to "principles" in general.
  const forgeDesign = ROUTER_SYSTEM.match(/^- forge_design ->.*$/m)?.[0];
  assert.ok(forgeDesign, "the router contract must describe forge_design");
  assert.match(forgeDesign, /Forge itself/);
  // And the phrasing trap that caused the miss must be called out explicitly.
  assert.match(ROUTER_SYSTEM, /never forge_design, however it is phrased/);
});

test("the router contract carries no project-specific routing rule", () => {
  // The boundary is fixed by meaning, not by vocabulary. A keyword for one project's
  // domain, a requirement id, or a literal question in the demo's UI language would
  // all make routing depend on the project rather than on the question's subject.
  const forbidden = [
    /outline/i,
    /petclinic/i,
    /document/i,
    /collection/i,
    /owner/i,
    /visit/i,
    /permission/i,
    /restore/i,
    /trash/i,
    /-search|same-day|nested-documents/i,
    // Any CJK character: the router reasons about meaning, never about a fixed phrase.
    /[　-鿿]/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(ROUTER_SYSTEM, pattern, `the router contract must not encode ${pattern}`);
  }
  // Every route still maps to exactly the sources the contract already fixed.
  for (const [route, source] of Object.entries(ROUTE_SOURCES)) {
    assert.ok(ROUTER_SYSTEM.includes(`- ${route} -> ${source}`), `${route} must stay mapped to ${source}`);
  }
});

function scriptedClient(results) {
  let index = 0;
  return {
    async complete() {
      return { result: results[index++], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, latencyMs: 1 };
    },
  };
}

const AUTHORITY_QUESTION = "権限の異なる子文書がある場合はどう扱いますか？";

test("an authority question routed to human_decision grounds in that requirement's open decisions", async () => {
  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "unresolved authority" },
    {
      sufficiency: "sufficient",
      answer: "未解決の判断があります。",
      impact_items: [],
      evidence: ["gaps.json#gap.cascade_restore_authorization"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval(AUTHORITY_QUESTION, client, "outline-restore-nested-documents");

  assert.equal(result.route, "human_decision");
  assert.deepEqual(result.retrievedSources, ["gaps.json"]);
  assert.equal(result.finalSufficiency, "sufficient");
  assert.ok(
    result.humanAuthority.some((item) => item.gap_id === "gap.cascade_restore_authorization"),
    "the authority decision must be reported as awaiting a human",
  );
  // No Forge-architecture answer and no other project's evidence.
  assert.ok(!result.retrievedSources.includes("architecture.md"));
  assert.doesNotMatch(JSON.stringify(result.evidence), /architecture\.md/);
  assert.doesNotMatch(result.answer, /Owner|Visit|Spring/i);
});

test("a question about Forge itself still retrieves only the shared design document", async () => {
  const client = scriptedClient([
    { route: "forge_design", primary_source: "architecture.md", reason: "about Forge" },
    {
      sufficiency: "sufficient",
      answer: "Forge は承認される振る舞いを変える判断だけを Human decision として扱います。",
      impact_items: [],
      evidence: ["architecture.md#authority"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval(
    "Forge は Human Decision と implementation detail をどう区別しますか？",
    client,
    "outline-restore-nested-documents",
  );

  assert.equal(result.route, "forge_design");
  assert.deepEqual(result.retrievedSources, ["architecture.md"]);
  // The requirement's own gaps are not reported as open decisions on this route.
  assert.deepEqual(result.humanAuthority, []);
});
