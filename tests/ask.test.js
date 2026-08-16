import test from "node:test";
import assert from "node:assert/strict";

import { handleAskRequest } from "../functions/_lib/service.js";
import { runRetrieval } from "../functions/_lib/retrieval.js";
import { REQUIREMENTS } from "../functions/_lib/artifacts.generated.js";

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

// Mirrors the shape the Cloudflare Cache API exposes to a Pages Function.
function makeCacheStorage() {
  const entries = new Map();
  return {
    entries,
    default: {
      async match(request) {
        const entry = entries.get(request.url);
        return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
      },
      async put(request, response) {
        entries.set(request.url, {
          body: await response.text(),
          headers: Object.fromEntries(response.headers),
        });
      },
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
  // Only the hash is persisted: the question text itself never reaches the audit row.
  assert.equal(audit.questionPreview, null);
  assert.doesNotMatch(serialized, /現在の検索/);
});

const CURRENT_BEHAVIOR_TURN = [
  { route: "current_behavior", primary_source: "project_context.json", reason: "behavior" },
  {
    sufficiency: "sufficient",
    answer: "現在は姓の前方一致だけで検索します。",
    impact_items: [],
    evidence: ["project_context.json#surface.api.search_endpoint"],
    additional_source: null,
    additional_reason: null,
  },
];

function askWithCache(question, { caches, store, client, dependencies = {} }) {
  return handleAskRequest(makeRequest(question), ENV, { store, client, caches, ...dependencies });
}

test("identical question is served from the runtime cache without a second Bailian call", async () => {
  const caches = makeCacheStorage();
  const store = makeStore();
  const client = scriptedClient([...CURRENT_BEHAVIOR_TURN, ...CURRENT_BEHAVIOR_TURN]);
  const question = "現在の検索は どう動いていますか？";

  const first = await responseJson(await askWithCache(question, { caches, store, client }));
  assert.equal(first.status, 200);
  assert.equal(client.calls, 2);
  assert.equal(store.calls.audit[0].cacheStatus, "miss");
  assert.equal(store.calls.audit[0].modelCalled, true);

  const second = await responseJson(await askWithCache(question, { caches, store, client }));
  assert.equal(second.status, 200);
  assert.equal(client.calls, 2, "cache HIT must not call Bailian again");
  assert.equal(second.body.answer, first.body.answer);
  assert.equal(second.body.route, first.body.route);
  assert.notEqual(second.body.request_id, first.body.request_id);

  // A HIT still consumes the client rate limit but never the global token budget.
  assert.equal(store.calls.rate.length, 2);
  assert.equal(store.calls.reserve.length, 1);
  assert.equal(store.calls.reconcile.length, 1);

  // Question normalization folds insignificant whitespace into the same key.
  const spaced = await responseJson(await askWithCache("現在の検索は　　どう動いていますか？", { caches, store, client }));
  assert.equal(spaced.status, 200);
  assert.equal(client.calls, 2);
  assert.equal(caches.entries.size, 1);
});

test("a different question misses the cache", async () => {
  const caches = makeCacheStorage();
  const store = makeStore();
  const client = scriptedClient([...CURRENT_BEHAVIOR_TURN, ...CURRENT_BEHAVIOR_TURN]);

  await askWithCache("現在の検索はどう動いていますか？", { caches, store, client });
  await askWithCache("現在の検索処理はどの層にありますか？", { caches, store, client });

  assert.equal(client.calls, 4);
  assert.equal(caches.entries.size, 2);
  assert.deepEqual(store.calls.audit.map((audit) => audit.cacheStatus), ["miss", "miss"]);
});

test("a changed context revision or prompt version misses the cache", async () => {
  const question = "現在の検索はどう動いていますか？";
  for (const changed of [{ contextRevision: "revision-2" }, { promptVersion: "prompt-2" }]) {
    const caches = makeCacheStorage();
    const store = makeStore();
    const client = scriptedClient([...CURRENT_BEHAVIOR_TURN, ...CURRENT_BEHAVIOR_TURN]);

    await askWithCache(question, { caches, store, client });
    const second = await responseJson(await askWithCache(question, { caches, store, client, dependencies: changed }));

    assert.equal(second.status, 200);
    assert.equal(client.calls, 4, `${Object.keys(changed)[0]} must invalidate the cache`);
    assert.equal(caches.entries.size, 2);
    assert.equal(store.calls.audit[1].cacheStatus, "miss");
  }
});

test("a deterministic insufficient result is cached and replayed as insufficient", async () => {
  const caches = makeCacheStorage();
  const store = makeStore();
  let retrievalCalls = 0;
  const retrieval = async () => {
    retrievalCalls += 1;
    return {
      questionType: "current_behavior",
      route: "current_behavior",
      primarySource: "project_context.json",
      additionalSource: null,
      additionalReason: null,
      modelSufficiency: "insufficient",
      finalSufficiency: "insufficient",
      retrievedSources: ["project_context.json"],
      answer: "取得した Project Context では回答できません。",
      evidence: ["project_context.json#relevant_implementation_surfaces"],
      impactItems: [],
      humanAuthority: [],
      guardrailsTriggered: [],
      validationWarnings: [],
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12, latencyMs: 4 },
    };
  };
  const question = "検索結果が空のときの文言は何ですか？";

  const first = await responseJson(await askWithCache(question, { caches, store, dependencies: { retrieval } }));
  const second = await responseJson(await askWithCache(question, { caches, store, dependencies: { retrieval } }));

  assert.equal(retrievalCalls, 1);
  assert.equal(second.status, 200);
  assert.equal(second.body.sufficiency, "insufficient");
  assert.equal(second.body.answer, first.body.answer);
  assert.equal(store.calls.audit[1].cacheStatus, "hit");
  assert.equal(store.calls.audit[1].modelCalled, false);
  assert.equal(store.calls.audit[1].resultStatus, "insufficient");
  assert.equal(store.calls.audit[1].totalTokens, 0);
});

test("upstream and budget failures are never cached", async () => {
  const caches = makeCacheStorage();
  const question = "現在の検索はどう動いていますか？";

  const blockedStore = makeStore({ reserve: { ok: false, reason: "token" } });
  const blocked = await responseJson(await askWithCache(question, {
    caches,
    store: blockedStore,
    client: { async complete() {} },
  }));
  assert.equal(blocked.status, 429);
  assert.equal(blockedStore.calls.audit[0].cacheStatus, "miss");
  assert.equal(blockedStore.calls.audit[0].modelCalled, false);
  assert.equal(caches.entries.size, 0);

  const errorStore = makeStore();
  const errorClient = scriptedClient([{ route: "made_up", primary_source: "secrets.txt", reason: "bad" }]);
  const failed = await responseJson(await askWithCache(question, { caches, store: errorStore, client: errorClient }));
  assert.equal(failed.status, 502);
  assert.equal(caches.entries.size, 0);

  const okStore = makeStore();
  const okClient = scriptedClient(CURRENT_BEHAVIOR_TURN);
  const retried = await responseJson(await askWithCache(question, { caches, store: okStore, client: okClient }));
  assert.equal(retried.status, 200);
  assert.equal(okClient.calls, 2, "a previous failure must not be replayed from the cache");
});

test("the cached record holds no secret, prompt, or client identity", async () => {
  const caches = makeCacheStorage();
  const store = makeStore();
  const client = scriptedClient(CURRENT_BEHAVIOR_TURN);
  await askWithCache("現在の検索はどう動いていますか？", { caches, store, client });

  const [[keyUrl, entry]] = [...caches.entries];
  assert.match(keyUrl, /^http:\/\/localhost\/__ask-forge-cache\/askforge-cache-v0\.1\/[a-f0-9]{64}$/);
  assert.equal(entry.headers["cache-control"], "max-age=86400");
  assert.doesNotMatch(entry.body, /test-secret-never-log|203\.0\.113\.9|Ask Forge answer step|Authorization/);
  assert.equal(JSON.parse(entry.body).payload.request_id, undefined);
});

test("client soft rate limit writes a blocked trace", async () => {
  const store = makeStore({ rateOk: false });
  const result = await responseJson(await handleAskRequest(makeRequest("質問"), ENV, { store }));
  assert.equal(result.status, 429);
  assert.equal(store.calls.reserve.length, 0);
  assert.equal(store.calls.audit[0].resultStatus, "blocked_rate_limit");
});

// --- Multi-requirement demo -------------------------------------------------
// The public demo serves more than one validated requirement. Each requirement
// must stay isolated: its own artifacts, its own gaps, its own cache entries.

const SAME_DAY = "same-day-visit";

const SAME_DAY_BEHAVIOR_TURN = [
  { route: "current_behavior", primary_source: "project_context.json", reason: "behavior" },
  {
    sufficiency: "sufficient",
    answer: "現在は翌日以降しか登録できません。",
    impact_items: [],
    evidence: ["project_context.json#surface.controller.visit_date_rule"],
    additional_source: null,
    additional_reason: null,
  },
];

test("a second registered requirement is accepted by the API", async () => {
  const store = makeStore();
  const client = scriptedClient([...SAME_DAY_BEHAVIOR_TURN]);
  const result = await responseJson(await handleAskRequest(
    makeRequest("現在の予約はどう動いていますか？", SAME_DAY), ENV, { store, client, requestId: "req-same-day" },
  ));
  assert.equal(result.status, 200);
  assert.equal(result.body.route, "current_behavior");
  assert.equal(store.calls.audit[0].requirementId, SAME_DAY);
});

test("each requirement reports only its own blocking Human decisions", async () => {
  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "open decisions" },
    {
      sufficiency: "sufficient",
      answer: "未解決の判断があります。",
      impact_items: [],
      evidence: ["gaps.json#gap.past_date_policy"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("実装前に人が決める必要があることは何ですか？", client, SAME_DAY);
  assert.deepEqual(
    result.humanAuthority.map((item) => item.gap_id),
    ["gap.past_date_policy", "gap.default_visit_date"],
  );
  // The first requirement's gaps must not leak into the second requirement's answer.
  assert.doesNotMatch(JSON.stringify(result.humanAuthority), /city/i);
});

test("non-blocking verifications and derived impact are never reported as Human decisions", async () => {
  const gaps = REQUIREMENTS[SAME_DAY].artifacts["gaps.json"];
  // Guard the guard: the artifact must actually carry both non-blocking categories,
  // otherwise this test would pass vacuously.
  assert.ok(gaps.non_blocking_verifications.length > 0);
  assert.ok(gaps.derived_implementation_impact.length > 0);

  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "open decisions" },
    {
      sufficiency: "sufficient",
      answer: "未解決の判断があります。",
      impact_items: [],
      evidence: ["gaps.json#gap.past_date_policy"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("実装前に人が決める必要があることは何ですか？", client, SAME_DAY);

  const reported = result.humanAuthority.map((item) => item.gap_id);
  const nonBlocking = [
    ...gaps.non_blocking_verifications.map((item) => item.id),
    ...gaps.derived_implementation_impact.map((item) => item.id),
  ];
  assert.equal(reported.length, 2, "only Approved-Target-changing decisions block");
  for (const id of nonBlocking) {
    assert.ok(!reported.includes(id), `${id} must not be reported as a Human decision`);
  }
});

test("impact surfaces belonging to another requirement are dropped", async () => {
  const client = scriptedClient([
    { route: "impact_scope", primary_source: "project_context.json", reason: "impact" },
    {
      sufficiency: "sufficient",
      answer: "影響範囲です。",
      impact_items: [
        { surface_id: "surface.controller.visit_date_rule", reason: "controller" },
        { surface_id: "surface.api.search_endpoint", reason: "owner-city-search only" },
      ],
      evidence: ["project_context.json#surface.controller.visit_date_rule"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("この要件はどこに影響しますか？", client, SAME_DAY);
  assert.deepEqual(result.impactItems.map((item) => item.surface_id), ["surface.controller.visit_date_rule"]);
  assert.match(result.validationWarnings.join(" "), /surface\.api\.search_endpoint/);
});

test("the same question under a different requirement is not served from the other's cache", async () => {
  const caches = makeCacheStorage();
  const store = makeStore();
  const client = scriptedClient([...CURRENT_BEHAVIOR_TURN, ...SAME_DAY_BEHAVIOR_TURN]);
  const question = "現在はどう動いていますか？";

  const first = await responseJson(await handleAskRequest(
    makeRequest(question, "owner-city-search"), ENV, { store, client, caches },
  ));
  const second = await responseJson(await handleAskRequest(
    makeRequest(question, SAME_DAY), ENV, { store, client, caches },
  ));

  assert.equal(client.calls, 4, "the second requirement must reach the model, not the cache");
  assert.equal(caches.entries.size, 2);
  assert.notEqual(second.body.answer, first.body.answer);
  assert.deepEqual(store.calls.audit.map((audit) => audit.cacheStatus), ["miss", "miss"]);
});

test("the public UI registry matches the server requirement registry", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const serverIds = Object.keys(REQUIREMENTS).sort();

  // The UI must offer exactly what the API accepts: an extra tab would produce a
  // rejected request, a missing one would hide a shipped requirement.
  const uiIds = [...new Set([...markup.matchAll(/data-requirement="([^"]+)"/g)].map((match) => match[1]))].sort();
  assert.deepEqual(uiIds, serverIds);

  for (const [id, requirement] of Object.entries(REQUIREMENTS)) {
    assert.ok(script.includes(`"${id}"`), `script.js must offer ${id}`);
    assert.ok(script.includes(requirement.base_path), `script.js must point ${id} at ${requirement.base_path}`);
  }
});
