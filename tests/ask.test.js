import test from "node:test";
import assert from "node:assert/strict";

import { handleAskRequest } from "../functions/_lib/service.js";
import { runRetrieval } from "../functions/_lib/retrieval.js";

const ENV = {
  BAILIAN_API_KEY: "test-secret-never-log",
  BAILIAN_BASE_URL: "https://example.invalid/compatible-mode/v1",
  BAILIAN_MODEL: "qwen3.7-plus",
  CLIENT_HASH_SALT: "test-salt",
};

function makeStore(options = {}) {
  const calls = { rate: [], reserve: [], reconcile: [], audit: [] };
  return {
    calls,
    async consumeClientRate(input) {
      calls.rate.push(structuredClone(input));
      return { ok: options.rateOk !== false };
    },
    async reserveGlobalBudget(input) {
      calls.reserve.push(structuredClone(input));
      return options.reserve || { ok: true };
    },
    async reconcileGlobalBudget(input) {
      calls.reconcile.push(structuredClone(input));
    },
    async writeAudit(input) {
      calls.audit.push(structuredClone(input));
    },
  };
}

function makeRequest(question, requirementId = "owner-city-search", headers = {}) {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers },
    body: JSON.stringify({ requirement_id: requirementId, question }),
  });
}

function scriptedClient(results) {
  let index = 0;
  return {
    get calls() {
      return index;
    },
    async complete() {
      const result = results[index++];
      if (result instanceof Error) throw result;
      return {
        result,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        latencyMs: 2,
      };
    },
  };
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

test("valid Human-decision question stays open and grounded", async () => {
  const store = makeStore();
  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "open decisions" },
    {
      sufficiency: "sufficient",
      answer: "実装前に三つの Human decision が必要です。",
      impact_items: [],
      evidence: ["gaps.json#gap.city_matching_semantics"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await responseJson(await handleAskRequest(
    makeRequest("実装前に人が決める必要があることは何ですか？"), ENV, { store, client, requestId: "req-human" },
  ));
  assert.equal(result.status, 200);
  assert.equal(result.body.route, "human_decision");
  assert.equal(result.body.sufficiency, "sufficient");
  assert.equal(result.body.human_authority.length, 3);
  assert.ok(result.body.human_authority.every((item) => item.status === "open"));
  assert.equal(client.calls, 2);
  assert.equal(store.calls.audit[0].resultStatus, "success");
});

test("impact output drops unsupported surfaces and model prose", async () => {
  const client = scriptedClient([
    { route: "impact_scope", primary_source: "project_context.json", reason: "impact" },
    {
      sufficiency: "sufficient",
      answer: "新しい Service 層とキャッシュも必要です。",
      impact_items: [
        { surface_id: "surface.api.search_endpoint", reason: "controller" },
        { surface_id: "surface.fake.cache", reason: "cache" },
      ],
      evidence: ["project_context.json#surface.api.search_endpoint"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("この要件はどこに影響しますか？", client);
  assert.deepEqual(result.impactItems.map((item) => item.surface_id), ["surface.api.search_endpoint"]);
  assert.doesNotMatch(result.answer, /Service 層|キャッシュ/);
  assert.match(result.validationWarnings.join(" "), /unsupported impact surface/);
});

test("why-not-decided follows explicit evidence_ref exactly once", async () => {
  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "why" },
    {
      sufficiency: "sufficient",
      answer: "根拠があります。",
      impact_items: [],
      evidence: ["gaps.json#gap.city_matching_semantics"],
      additional_source: null,
      additional_reason: null,
    },
    {
      sufficiency: "sufficient",
      answer: "姓の前方一致は観測できますが、city の方式は未決定です。",
      impact_items: [],
      evidence: ["gaps.json#gap.city_matching_semantics"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("なぜ city の照合方法を Forge は自動で決めなかったのですか？", client);
  assert.equal(client.calls, 3);
  assert.deepEqual(result.retrievedSources, ["gaps.json", "project_context.json"]);
  assert.ok(result.evidence.includes("project_context.json#surface.repository.owner_lookup"));
});

test("authentication is insufficient without an upstream call", async () => {
  const store = makeStore();
  let upstreamCalls = 0;
  const result = await responseJson(await handleAskRequest(
    makeRequest("この要件では認証方式をどう変更すべきですか？"), ENV,
    { store, client: { async complete() { upstreamCalls += 1; } }, requestId: "req-auth" },
  ));
  assert.equal(result.status, 200);
  assert.equal(result.body.sufficiency, "insufficient");
  assert.match(result.body.answer, /認証方式に関する根拠がない/);
  assert.equal(upstreamCalls, 0);
  assert.equal(store.calls.reserve.length, 0);
});

test("questions over 500 characters are rejected", async () => {
  const store = makeStore();
  const result = await responseJson(await handleAskRequest(makeRequest("あ".repeat(501)), ENV, { store }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /500/);
  assert.equal(store.calls.reserve.length, 0);
});

test("unsupported requirement is rejected", async () => {
  const store = makeStore();
  const result = await responseJson(await handleAskRequest(makeRequest("質問", "another-requirement"), ENV, { store }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /指定された要件/);
  assert.equal(store.calls.reserve.length, 0);
});

test("malformed JSON returns a safe validation error", async () => {
  const store = makeStore();
  const request = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  const result = await responseJson(await handleAskRequest(request, ENV, { store }));
  assert.equal(result.status, 400);
  assert.deepEqual(Object.keys(result.body).sort(), ["error", "request_id"]);
});

test("non-JSON content type is rejected", async () => {
  const store = makeStore();
  const request = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "question",
  });
  const result = await responseJson(await handleAskRequest(request, ENV, { store }));
  assert.equal(result.status, 415);
  assert.match(result.body.error, /application\/json/);
});

test("global request budget blocks before upstream", async () => {
  const store = makeStore({ reserve: { ok: false, reason: "request" } });
  let upstreamCalls = 0;
  const result = await responseJson(await handleAskRequest(makeRequest("現在の検索はどう動いていますか？"), ENV, {
    store,
    client: { async complete() { upstreamCalls += 1; } },
  }));
  assert.equal(result.status, 429);
  assert.match(result.body.error, /本日の Live Ask Forge/);
  assert.equal(upstreamCalls, 0);
  assert.equal(store.calls.audit[0].resultStatus, "blocked_global_budget");
});

test("global token budget blocks before upstream", async () => {
  const store = makeStore({ reserve: { ok: false, reason: "token" } });
  let upstreamCalls = 0;
  const result = await responseJson(await handleAskRequest(makeRequest("現在の検索はどう動いていますか？"), ENV, {
    store,
    client: { async complete() { upstreamCalls += 1; } },
  }));
  assert.equal(result.status, 429);
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(store.calls.audit[0].guardrailsTriggered, ["global_token_budget"]);
});

test("malformed model response fails safely without retry", async () => {
  const store = makeStore();
  const client = scriptedClient([{ route: "made_up", primary_source: "secrets.txt", reason: "bad" }]);
  const result = await responseJson(await handleAskRequest(makeRequest("現在の検索はどう動いていますか？"), ENV, { store, client }));
  assert.equal(result.status, 502);
  assert.match(result.body.error, /安全に検証/);
  assert.equal(client.calls, 1);
  assert.equal(store.calls.reconcile.length, 1);
  assert.equal(store.calls.audit[0].resultStatus, "upstream_error");
});

test("audit contains route, usage, and no API key or raw IP", async () => {
  const store = makeStore();
  const retrieval = async () => ({
    questionType: "current_behavior",
    route: "current_behavior",
    primarySource: "project_context.json",
    additionalSource: null,
    additionalReason: null,
    modelSufficiency: "sufficient",
    finalSufficiency: "sufficient",
    retrievedSources: ["project_context.json"],
    answer: "現在の検索動作です。",
    evidence: ["project_context.json#surface.api.search_endpoint"],
    impactItems: [],
    humanAuthority: [],
    guardrailsTriggered: [],
    validationWarnings: [],
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, latencyMs: 7 },
  });
  const response = await handleAskRequest(makeRequest("現在の検索はどう動いていますか？"), ENV, { store, retrieval });
  assert.equal(response.status, 200);
  const audit = store.calls.audit[0];
  assert.equal(audit.route, "current_behavior");
  assert.equal(audit.totalTokens, 16);
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /test-secret-never-log|203\.0\.113\.9/);
  assert.match(audit.questionHash, /^[a-f0-9]{64}$/);
});

test("client soft rate limit writes a blocked trace", async () => {
  const store = makeStore({ rateOk: false });
  const result = await responseJson(await handleAskRequest(makeRequest("質問"), ENV, { store }));
  assert.equal(result.status, 429);
  assert.equal(store.calls.reserve.length, 0);
  assert.equal(store.calls.audit[0].resultStatus, "blocked_rate_limit");
});
