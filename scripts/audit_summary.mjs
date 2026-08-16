#!/usr/bin/env node
// Aggregate the Ask Forge D1 audit_traces table into a short operational summary.
//
// The projection below is the privacy boundary of this tool: question text,
// question_hash, client information, secrets, raw IP and prompts are never
// selected, so they can never reach stdout. The legacy question_preview column
// still exists in the schema (always written as NULL by current requests) and is
// deliberately not read here.
//
// Usage:
//   node scripts/audit_summary.mjs --local
//   node scripts/audit_summary.mjs --remote --days 7
//   node scripts/audit_summary.mjs --local --json

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DATABASE = "ask-forge-demo";

// Kept on one line: the --remote path rejects a --command containing newlines.
const SELECT_COLUMNS =
  "created_at, route, result_status, final_sufficiency, cache_status, model_called, total_tokens, latency_ms, " +
  "CASE WHEN additional_source IS NULL OR additional_source = '' THEN 0 ELSE 1 END AS additional_retrieval, " +
  "guardrails_triggered";

export function parseArgs(argv) {
  const options = { target: "local", since: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg, null];
    const value = () => {
      const next = inlineValue ?? argv[index + 1];
      if (inlineValue == null) index += 1;
      return next;
    };
    switch (flag) {
      case "--local":
        options.target = "local";
        break;
      case "--remote":
        options.target = "remote";
        break;
      case "--json":
        options.json = true;
        break;
      case "--since":
        options.since = value();
        break;
      case "--days": {
        const days = Number.parseInt(String(value() ?? ""), 10);
        if (!Number.isFinite(days) || days <= 0) throw new Error("--days requires a positive integer");
        options.since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Interpolated into SQL, so only an exact calendar date is ever accepted.
  if (options.since != null && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) {
    throw new Error("--since requires YYYY-MM-DD");
  }
  return options;
}

export function buildQuery(since) {
  const where = since ? ` WHERE created_at >= '${since}'` : "";
  return `SELECT ${SELECT_COLUMNS} FROM audit_traces${where} ORDER BY created_at;`;
}

// Wrangler prints a human banner around the JSON payload depending on version and
// TTY, so take the outermost bracketed value instead of parsing the whole stream.
export function extractJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("wrangler did not return JSON output");
  return JSON.parse(stdout.slice(start, end + 1));
}

export function rowsFromWranglerResult(payload) {
  const rows = [];
  for (const entry of Array.isArray(payload) ? payload : []) {
    if (Array.isArray(entry?.results)) rows.push(...entry.results);
  }
  return rows;
}

// Nearest-rank percentile over an ascending list; returns null for an empty list.
export function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return null;
  const rank = Math.ceil(fraction * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length, Math.max(1, rank)) - 1];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function latencyStats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    averageMs: average(sorted),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function bump(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

function guardrails(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function summarize(rows) {
  const summary = {
    totalRequests: rows.length,
    firstCreatedAt: null,
    lastCreatedAt: null,
    resultStatus: {},
    route: {},
    finalSufficiency: {},
    cache: { hit: 0, miss: 0, bypass: 0, other: 0, hitRate: null },
    model: { called: 0, notCalled: 0, callRate: null, totalTokens: 0, averageTokensPerCall: null },
    latencyAll: latencyStats([]),
    latencyModelCalled: latencyStats([]),
    additionalRetrieval: { count: 0, rate: null },
    deterministicController: 0,
    blockedRateLimit: 0,
    blockedGlobalBudget: 0,
    upstreamError: 0,
  };

  const allLatencies = [];
  const modelLatencies = [];

  for (const row of rows) {
    const createdAt = row.created_at == null ? null : String(row.created_at);
    if (createdAt) {
      if (summary.firstCreatedAt == null || createdAt < summary.firstCreatedAt) summary.firstCreatedAt = createdAt;
      if (summary.lastCreatedAt == null || createdAt > summary.lastCreatedAt) summary.lastCreatedAt = createdAt;
    }

    const resultStatus = row.result_status == null ? "(none)" : String(row.result_status);
    bump(summary.resultStatus, resultStatus);
    bump(summary.route, row.route == null ? "(none)" : String(row.route));
    bump(summary.finalSufficiency, row.final_sufficiency == null ? "(none)" : String(row.final_sufficiency));

    const cacheStatus = String(row.cache_status ?? "bypass");
    if (cacheStatus in summary.cache && cacheStatus !== "hitRate") summary.cache[cacheStatus] += 1;
    else summary.cache.other += 1;

    const latency = Number(row.latency_ms || 0);
    allLatencies.push(latency);

    const modelCalled = Number(row.model_called || 0) === 1;
    if (modelCalled) {
      summary.model.called += 1;
      summary.model.totalTokens += Number(row.total_tokens || 0);
      modelLatencies.push(latency);
    } else {
      summary.model.notCalled += 1;
    }

    if (Number(row.additional_retrieval || 0) === 1) summary.additionalRetrieval.count += 1;
    if (guardrails(row.guardrails_triggered).includes("deterministic_controller")) summary.deterministicController += 1;
    if (resultStatus === "blocked_rate_limit") summary.blockedRateLimit += 1;
    if (resultStatus === "blocked_global_budget") summary.blockedGlobalBudget += 1;
    if (resultStatus === "upstream_error") summary.upstreamError += 1;
  }

  if (summary.totalRequests > 0) {
    summary.cache.hitRate = summary.cache.hit / summary.totalRequests;
    summary.model.callRate = summary.model.called / summary.totalRequests;
    summary.additionalRetrieval.rate = summary.additionalRetrieval.count / summary.totalRequests;
  }
  if (summary.model.called > 0) {
    summary.model.averageTokensPerCall = summary.model.totalTokens / summary.model.called;
  }
  summary.latencyAll = latencyStats(allLatencies);
  summary.latencyModelCalled = latencyStats(modelLatencies);
  return summary;
}

function percent(rate) {
  return rate == null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function ms(value) {
  return value == null ? "n/a" : `${Math.round(value)} ms`;
}

function counts(label, counter) {
  const entries = Object.entries(counter).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (!entries.length) return [`${label}: (none)`];
  return [`${label}:`, ...entries.map(([key, value]) => `  ${key}: ${value}`)];
}

export function formatSummary(summary, context = {}) {
  const lines = [
    "Ask Forge audit summary",
    `target: ${context.target || "local"}${context.since ? `  since: ${context.since}` : ""}`,
    `window: ${summary.firstCreatedAt || "n/a"} .. ${summary.lastCreatedAt || "n/a"}`,
    "",
    `total requests: ${summary.totalRequests}`,
    "",
    ...counts("result_status", summary.resultStatus),
    "",
    ...counts("route", summary.route),
    "",
    ...counts("final_sufficiency", summary.finalSufficiency),
    "",
    "cache:",
    `  hit: ${summary.cache.hit}`,
    `  miss: ${summary.cache.miss}`,
    `  bypass: ${summary.cache.bypass}`,
    ...(summary.cache.other ? [`  other: ${summary.cache.other}`] : []),
    `  hit rate: ${percent(summary.cache.hitRate)}`,
    "",
    "model:",
    `  called: ${summary.model.called}`,
    `  not called: ${summary.model.notCalled}`,
    `  call rate: ${percent(summary.model.callRate)}`,
    `  total tokens: ${summary.model.totalTokens}`,
    `  average tokens per model call: ${
      summary.model.averageTokensPerCall == null ? "n/a" : summary.model.averageTokensPerCall.toFixed(1)
    }`,
    "",
    "latency (all requests):",
    `  average: ${ms(summary.latencyAll.averageMs)}`,
    `  p50: ${ms(summary.latencyAll.p50Ms)}`,
    `  p95: ${ms(summary.latencyAll.p95Ms)}`,
    "",
    `latency (model_called only, n=${summary.latencyModelCalled.count}):`,
    `  average: ${ms(summary.latencyModelCalled.averageMs)}`,
    `  p50: ${ms(summary.latencyModelCalled.p50Ms)}`,
    `  p95: ${ms(summary.latencyModelCalled.p95Ms)}`,
    "",
    "guardrails / retrieval:",
    `  additional retrieval: ${summary.additionalRetrieval.count} (${percent(summary.additionalRetrieval.rate)})`,
    `  deterministic_controller: ${summary.deterministicController}`,
    `  blocked_rate_limit: ${summary.blockedRateLimit}`,
    `  blocked_global_budget: ${summary.blockedGlobalBudget}`,
    `  upstream_error: ${summary.upstreamError}`,
  ];
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const args = [
    "wrangler",
    "d1",
    "execute",
    DATABASE,
    options.target === "remote" ? "--remote" : "--local",
    "--json",
    "--command",
    buildQuery(options.since),
  ];
  let stdout;
  try {
    ({ stdout } = await execFileAsync("npx", args, { maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    // execFile only reports the command line, which hides the reason wrangler failed.
    throw new Error(`wrangler d1 execute failed:\n${error?.stderr || error?.stdout || error?.message || error}`);
  }
  const rows = rowsFromWranglerResult(extractJson(stdout));
  const summary = summarize(rows);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `${formatSummary(summary, { target: options.target, since: options.since })}\n`,
  );
}

// Only the CLI entry point runs wrangler; importing this module stays side-effect free.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
