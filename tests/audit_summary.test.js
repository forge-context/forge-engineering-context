import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuery,
  extractJson,
  formatSummary,
  parseArgs,
  percentile,
  rowsFromWranglerResult,
  summarize,
} from "../scripts/audit_summary.mjs";

// One row per shape the Pages Function can write, including a legacy row from
// before migration 0002 added cache_status and model_called.
const FIXTURE_ROWS = [
  {
    created_at: "2026-08-16T01:00:00.000Z",
    route: "current_behavior",
    result_status: "success",
    final_sufficiency: "sufficient",
    cache_status: "miss",
    model_called: 1,
    total_tokens: 3000,
    latency_ms: 8700,
    additional_retrieval: 0,
    guardrails_triggered: "[]",
  },
  {
    created_at: "2026-08-16T01:00:10.000Z",
    route: "current_behavior",
    result_status: "success",
    final_sufficiency: "sufficient",
    cache_status: "hit",
    model_called: 0,
    total_tokens: 0,
    latency_ms: 0,
    additional_retrieval: 0,
    guardrails_triggered: "[]",
  },
  {
    created_at: "2026-08-16T01:01:00.000Z",
    route: "human_decision",
    result_status: "success",
    final_sufficiency: "sufficient",
    cache_status: "miss",
    model_called: 1,
    total_tokens: 5000,
    latency_ms: 12000,
    additional_retrieval: 1,
    guardrails_triggered: '["deterministic_controller"]',
  },
  {
    created_at: "2026-08-16T01:02:00.000Z",
    route: "human_decision",
    result_status: "insufficient",
    final_sufficiency: "insufficient",
    cache_status: "bypass",
    model_called: 0,
    total_tokens: 0,
    latency_ms: 0,
    additional_retrieval: 0,
    guardrails_triggered: '["requirement_scope_gate","no_silent_inference"]',
  },
  {
    created_at: "2026-08-16T01:03:00.000Z",
    route: null,
    result_status: "blocked_rate_limit",
    final_sufficiency: null,
    cache_status: "bypass",
    model_called: 0,
    total_tokens: 0,
    latency_ms: 0,
    additional_retrieval: 0,
    guardrails_triggered: '["client_rate_limit"]',
  },
  {
    created_at: "2026-08-16T01:04:00.000Z",
    route: null,
    result_status: "blocked_global_budget",
    final_sufficiency: null,
    cache_status: "miss",
    model_called: 0,
    total_tokens: 0,
    latency_ms: 0,
    additional_retrieval: 0,
    guardrails_triggered: '["global_token_budget"]',
  },
  {
    created_at: "2026-08-16T01:05:00.000Z",
    route: "impact_scope",
    result_status: "upstream_error",
    upstream_error_kind: "malformed_model_json",
    final_sufficiency: null,
    cache_status: "miss",
    model_called: 1,
    total_tokens: 1200,
    latency_ms: 4000,
    additional_retrieval: 0,
    guardrails_triggered: '["fail_safe_upstream"]',
  },
  {
    // Legacy row written before migration 0002 added cache_status / model_called.
    created_at: "2026-08-15T23:00:00.000Z",
    route: "forge_design",
    result_status: "success",
    final_sufficiency: "sufficient",
    cache_status: "bypass",
    model_called: 0,
    total_tokens: 0,
    latency_ms: 5000,
    additional_retrieval: 0,
    guardrails_triggered: "[]",
  },
];

// Upstream failures from before migrations 0003 / 0004, and after them.
const UPSTREAM_ROWS = [
  { created_at: "2026-08-16T02:00:00.000Z", result_status: "upstream_error", upstream_error_kind: "api" },
  {
    created_at: "2026-08-16T02:01:00.000Z",
    result_status: "upstream_error",
    upstream_error_kind: "malformed_model_json",
    upstream_failure_stage: "content_json",
    upstream_finish_reason: "length",
  },
  { created_at: "2026-08-16T02:02:00.000Z", result_status: "upstream_error", upstream_error_kind: "internal" },
  { created_at: "2026-08-16T02:03:00.000Z", result_status: "upstream_error", upstream_error_kind: null },
  { created_at: "2026-08-16T02:04:00.000Z", result_status: "success", upstream_error_kind: null },
];

test("summarize aggregates every reported audit dimension", () => {
  const summary = summarize(FIXTURE_ROWS);

  assert.equal(summary.totalRequests, 8);
  assert.equal(summary.firstCreatedAt, "2026-08-15T23:00:00.000Z");
  assert.equal(summary.lastCreatedAt, "2026-08-16T01:05:00.000Z");

  assert.deepEqual(summary.resultStatus, {
    success: 4,
    insufficient: 1,
    blocked_rate_limit: 1,
    blocked_global_budget: 1,
    upstream_error: 1,
  });
  assert.deepEqual(summary.route, {
    current_behavior: 2,
    human_decision: 2,
    impact_scope: 1,
    forge_design: 1,
    "(none)": 2,
  });
  assert.deepEqual(summary.finalSufficiency, { sufficient: 4, insufficient: 1, "(none)": 3 });

  assert.equal(summary.cache.hit, 1);
  assert.equal(summary.cache.miss, 4);
  assert.equal(summary.cache.bypass, 3);
  assert.equal(summary.cache.hitRate, 1 / 8);

  assert.equal(summary.model.called, 3);
  assert.equal(summary.model.notCalled, 5);
  assert.equal(summary.model.callRate, 3 / 8);
  assert.equal(summary.model.totalTokens, 9200);
  assert.equal(summary.model.averageTokensPerCall, 9200 / 3);

  assert.equal(summary.latencyAll.averageMs, (8700 + 12000 + 4000 + 5000) / 8);
  assert.equal(summary.latencyModelCalled.count, 3);
  assert.equal(summary.latencyModelCalled.averageMs, (8700 + 12000 + 4000) / 3);
  assert.equal(summary.latencyModelCalled.p50Ms, 8700);
  assert.equal(summary.latencyModelCalled.p95Ms, 12000);

  assert.equal(summary.additionalRetrieval.count, 1);
  assert.equal(summary.additionalRetrieval.rate, 1 / 8);
  assert.equal(summary.deterministicController, 1);
  assert.equal(summary.blockedRateLimit, 1);
  assert.equal(summary.blockedGlobalBudget, 1);
  assert.equal(summary.upstreamError, 1);
  assert.deepEqual(summary.upstreamErrorKind, { malformed_model_json: 1 });
});

test("upstream failures are counted per safe error kind", () => {
  const summary = summarize([...FIXTURE_ROWS, ...UPSTREAM_ROWS]);

  assert.equal(summary.upstreamError, 5);
  assert.deepEqual(summary.upstreamErrorKind, {
    malformed_model_json: 2,
    api: 1,
    internal: 1,
    "(none)": 1,
  });

  // A parsing failure is broken down further; transport failures add no stage noise.
  assert.deepEqual(summary.upstreamFailureStage, { content_json: 1 });
  assert.deepEqual(summary.upstreamFinishReason, { length: 1 });

  const output = formatSummary(summary);
  assert.match(output, /upstream errors:/);
  assert.match(output, /malformed_model_json: 2/);
  assert.match(output, /api: 1/);
  assert.match(output, /failure stage:\n {4}content_json: 1/);
  assert.match(output, /finish reason:\n {4}length: 1/);
  // Kinds that never occurred are not printed, and the existing totals stay.
  assert.doesNotMatch(output, /timeout|quota|authentication/);
  assert.match(output, /upstream_error: 5/);
  assert.match(output, /total requests: 13/);
});

test("a failure with no parsing stage prints no stage breakdown", () => {
  const output = formatSummary(summarize([
    { created_at: "2026-08-16T03:00:00.000Z", result_status: "upstream_error", upstream_error_kind: "timeout" },
  ]));
  assert.match(output, /timeout: 1/);
  assert.doesNotMatch(output, /failure stage|finish reason/);
});

test("a table without upstream failures prints no kind breakdown", () => {
  const output = formatSummary(summarize(FIXTURE_ROWS.filter((row) => row.result_status !== "upstream_error")));
  assert.match(output, /upstream_error: 0/);
  assert.doesNotMatch(output, /upstream errors:/);
});

test("summarize stays defined on an empty table", () => {
  const summary = summarize([]);
  assert.equal(summary.totalRequests, 0);
  assert.equal(summary.cache.hitRate, null);
  assert.equal(summary.model.averageTokensPerCall, null);
  assert.equal(summary.latencyAll.p95Ms, null);
  assert.match(formatSummary(summary), /total requests: 0/);
});

test("percentile uses nearest rank", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
});

test("the query never selects question, client, or preview columns", () => {
  const query = buildQuery(null);
  assert.doesNotMatch(query, /question_preview|question_hash|client/);
  assert.match(query, /upstream_error_kind/);
  assert.match(buildQuery("2026-08-01"), /WHERE created_at >= '2026-08-01'/);
});

test("argument parsing rejects anything that is not a plain calendar date", () => {
  assert.deepEqual(parseArgs(["--remote"]), { target: "remote", since: null, json: false });
  assert.deepEqual(parseArgs(["--local", "--since", "2026-08-01"]), {
    target: "local",
    since: "2026-08-01",
    json: false,
  });
  assert.equal(parseArgs(["--since=2026-08-01", "--json"]).json, true);
  assert.throws(() => parseArgs(["--since", "2026-08-01'; DROP TABLE audit_traces --"]), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(["--days", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("wrangler output is read from the JSON payload only", () => {
  const stdout = '🌀 Executing on local database\n[{"results":[{"route":"forge_design"}],"success":true}]\n';
  const rows = rowsFromWranglerResult(extractJson(stdout));
  assert.deepEqual(rows, [{ route: "forge_design" }]);
  assert.throws(() => extractJson("no json here"), /did not return JSON/);
});
