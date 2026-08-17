#!/usr/bin/env node
// Runs one requirement's qualification cases through the real Ask Forge request
// handler and the real model, locally. It never touches the deployed API, the
// remote D1 database, or the response cache: the store is in memory and the cache
// is disabled, so every case exercises the model path.
//
//   node scripts/qualify_ask_forge.mjs docs/evaluation/<file>.json [--write]
//
// The file supplies `requirement_id` and `cases[].question`; observed values are
// printed, and written back into the same file only with --write.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { handleAskRequest } from "../functions/_lib/service.js";

const [recordPath, ...flags] = process.argv.slice(2);
if (!recordPath) {
  console.error("usage: node scripts/qualify_ask_forge.mjs <qualification.json> [--write]");
  process.exit(2);
}
const write = flags.includes("--write");
// `--only A,C` re-runs a subset without spending tokens on the cases already observed.
const onlyFlag = flags.find((flag) => flag.startsWith("--only="));
const only = onlyFlag ? new Set(onlyFlag.slice("--only=".length).split(",")) : null;

// The key is read from the local .dev.vars only, and is never printed.
async function loadEnv() {
  const text = await readFile(resolve(process.cwd(), ".dev.vars"), "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  if (!env.BAILIAN_API_KEY || !env.BAILIAN_BASE_URL) {
    throw new Error(".dev.vars must define BAILIAN_API_KEY and BAILIAN_BASE_URL");
  }
  return env;
}

function memoryStore() {
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
      audit.push(trace);
    },
  };
}

// Disabled rather than in-memory: a HIT would report zero tokens and hide the
// behavior the qualification is trying to observe.
const noCache = { async read() { return null; }, async write() {} };

async function runCase(env, requirementId, question) {
  const store = memoryStore();
  const request = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requirement_id: requirementId, question }),
  });
  const response = await handleAskRequest(request, env, { store, cache: noCache });
  const body = await response.json();
  const trace = store.audit[store.audit.length - 1] || {};
  return {
    actual_route: trace.route ?? null,
    sufficiency: trace.finalSufficiency ?? null,
    retrieved_sources: body.retrieved_sources ?? [],
    guardrails_triggered: trace.guardrailsTriggered ?? [],
    validation_warnings: trace.validationWarnings ?? [],
    additional_retrieval: Boolean(trace.additionalSource),
    additional_source: trace.additionalSource ?? null,
    model_called: Boolean(trace.modelCalled),
    total_tokens: trace.totalTokens ?? 0,
    latency_ms: trace.latencyMs ?? 0,
    result_status: trace.resultStatus ?? null,
    upstream_error_kind: trace.upstreamErrorKind ?? null,
    upstream_failure_stage: trace.upstreamFailureStage ?? null,
    upstream_finish_reason: trace.upstreamFinishReason ?? null,
    human_authority: (body.human_authority || []).map((item) => item.gap_id),
    impact_items: (body.impact_items || []).map((item) => item.surface_id),
    evidence: body.evidence ?? [],
    answer: body.answer ?? body.error ?? "",
    http_status: response.status,
  };
}

const env = await loadEnv();
const record = JSON.parse(await readFile(resolve(process.cwd(), recordPath), "utf8"));

for (const item of record.cases) {
  if (only && !only.has(item.id)) continue;
  const observed = await runCase(env, record.requirement_id, item.question);
  Object.assign(item, observed);
  console.log(
    [
      `[${item.id}] ${item.category}`,
      `  expected ${item.expected_route} / actual ${observed.actual_route} / ${observed.sufficiency}`,
      `  sources ${JSON.stringify(observed.retrieved_sources)} model_called ${observed.model_called} tokens ${observed.total_tokens} status ${observed.result_status}`,
      `  upstream ${observed.upstream_error_kind ?? "-"} / ${observed.upstream_failure_stage ?? "-"} / ${observed.upstream_finish_reason ?? "-"}`,
      `  gaps ${JSON.stringify(observed.human_authority)} impact ${JSON.stringify(observed.impact_items)}`,
      `  answer ${observed.answer.replace(/\s+/g, " ").slice(0, 400)}`,
    ].join("\n"),
  );
}

if (write) {
  await writeFile(resolve(process.cwd(), recordPath), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`\nwrote observed values back into ${recordPath}`);
}
