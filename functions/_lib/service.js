import { ARTIFACTS_REVISION } from "./artifacts.generated.js";
import { createBailianClient, resolveModel, UpstreamError } from "./bailian.js";
import { buildCacheKey, createRuntimeCache, CACHE_TTL_SECONDS } from "./cache.js";
import { isKnownRequirement, PROMPT_VERSION, runRetrieval } from "./retrieval.js";
import { createD1Store } from "./storage.js";

const LIMIT_MESSAGE = "本日の Live Ask Forge の利用上限に達しました。公開 Demo と Reference Artifacts は引き続き確認できます。";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jstBuckets(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const usageDate = `${parts.year}-${parts.month}-${parts.day}`;
  return { usageDate, hourBucket: `${usageDate}T${parts.hour}` };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isOutOfScope(question) {
  return /(認証|authentication|MFA|OAuth|JWT|ログイン方式)/i.test(question);
}

// The cacheable half of the response: request_id is always minted per request,
// so a cached entry can never replay another request's identifier.
function groundedPayload(result) {
  return {
    route: result.route,
    sufficiency: result.finalSufficiency,
    retrieved_sources: result.retrievedSources,
    answer: result.answer,
    evidence: result.evidence,
    impact_items: result.impactItems,
    human_authority: result.humanAuthority,
  };
}

function publicResult(requestId, result) {
  return { request_id: requestId, ...groundedPayload(result) };
}

function baseTrace({ requestId, nowIso, requirementId, questionHash }) {
  return {
    requestId,
    createdAt: nowIso,
    requirementId,
    questionHash,
    // The question itself is never persisted: only its hash. The existing
    // question_preview column stays in the schema and is always written as NULL.
    questionPreview: null,
    questionType: null,
    route: null,
    primarySource: null,
    additionalSource: null,
    additionalReason: null,
    modelSufficiency: null,
    finalSufficiency: null,
    guardrailsTriggered: [],
    validationWarnings: [],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    resultStatus: "validation_error",
    cacheStatus: "bypass",
    modelCalled: false,
  };
}

// Only retrieval-derived trace fields survive a cache round-trip; request identity
// and usage always come from the live request.
const CACHED_TRACE_FIELDS = Object.freeze([
  "questionType",
  "route",
  "primarySource",
  "additionalSource",
  "additionalReason",
  "modelSufficiency",
  "finalSufficiency",
  "guardrailsTriggered",
  "validationWarnings",
]);

function pickCachedTrace(source) {
  const picked = {};
  for (const field of CACHED_TRACE_FIELDS) {
    if (source && field in source) picked[field] = source[field];
  }
  return picked;
}

async function writeAuditSafely(store, trace) {
  try {
    await store.writeAudit(trace);
  } catch {
    // Audit availability must not leak storage details or replace a safe API response.
  }
}

export async function handleAskRequest(request, env, dependencies = {}) {
  const requestId = dependencies.requestId || crypto.randomUUID();
  const now = dependencies.now || new Date();
  const nowIso = now.toISOString();
  const { usageDate, hourBucket } = jstBuckets(now);
  const store = dependencies.store || createD1Store(env.DB);
  let requirementId = null;
  let question = "";
  let questionHash = null;

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return json({ request_id: requestId, error: "Content-Type は application/json を指定してください。" }, 415);
  }

  const rawClient = request.headers.get("CF-Connecting-IP") || "local";
  const salt = String(env.CLIENT_HASH_SALT || env.BAILIAN_API_KEY || "local-development-only");
  const clientHash = await sha256(`${salt}:${rawClient}`);
  const rate = await store.consumeClientRate({
    clientHash,
    usageDate,
    hourBucket,
    hourlyLimit: positiveInteger(env.CLIENT_HOURLY_REQUEST_LIMIT, 10),
    dailyLimit: positiveInteger(env.CLIENT_DAILY_REQUEST_LIMIT, 30),
    nowIso,
  });
  if (!rate.ok) {
    const trace = baseTrace({ requestId, nowIso, requirementId, questionHash });
    trace.guardrailsTriggered = ["client_rate_limit"];
    trace.resultStatus = "blocked_rate_limit";
    await writeAuditSafely(store, trace);
    return json({ request_id: requestId, error: "利用回数が上限に達しました。時間をおいて再度お試しください。" }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ request_id: requestId, error: "JSON を読み取れませんでした。" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ request_id: requestId, error: "リクエスト形式が正しくありません。" }, 400);
  }
  requirementId = typeof body.requirement_id === "string" ? body.requirement_id : null;
  question = typeof body.question === "string" ? body.question.trim() : "";
  questionHash = await sha256(question);
  const trace = baseTrace({ requestId, nowIso, requirementId, questionHash });

  // The requirement id selects which artifact set may be retrieved, so an unknown
  // id is rejected before any retrieval or budget reservation.
  if (!isKnownRequirement(requirementId)) {
    await writeAuditSafely(store, trace);
    return json({ request_id: requestId, error: "この公開 Demo では指定された要件を扱えません。" }, 400);
  }
  if (!question) {
    await writeAuditSafely(store, trace);
    return json({ request_id: requestId, error: "質問を入力してください。" }, 400);
  }
  if ([...question].length > 500) {
    await writeAuditSafely(store, trace);
    return json({ request_id: requestId, error: "質問は 500 文字以内で入力してください。" }, 400);
  }

  if (isOutOfScope(question)) {
    Object.assign(trace, {
      questionType: "out_of_scope",
      route: "human_decision",
      primarySource: "gaps.json",
      finalSufficiency: "insufficient",
      guardrailsTriggered: ["requirement_scope_gate", "no_silent_inference"],
      resultStatus: "insufficient",
    });
    await writeAuditSafely(store, trace);
    return json(
      publicResult(requestId, {
        route: "human_decision",
        finalSufficiency: "insufficient",
        retrievedSources: ["gaps.json"],
        answer: "この要件の公開 Project Context には認証方式に関する根拠がないため、変更内容を判断できません。",
        evidence: ["gaps.json#gaps"],
        impactItems: [],
        humanAuthority: [],
      }),
    );
  }

  // Runtime response cache: keyed only by server-derived identity, checked before
  // any global budget reservation so a HIT never consumes model-token budget.
  const cache = dependencies.cache || createRuntimeCache(dependencies.caches);
  let cacheKey = null;
  try {
    cacheKey = await buildCacheKey({
      origin: new URL(request.url).origin,
      requirementId,
      question,
      contextRevision: dependencies.contextRevision || ARTIFACTS_REVISION,
      promptVersion: dependencies.promptVersion || PROMPT_VERSION,
      model: resolveModel(env),
    });
  } catch {
    cacheKey = null;
  }

  const cached = cacheKey ? await cache.read(cacheKey.url) : null;
  if (cached) {
    Object.assign(trace, pickCachedTrace(cached.trace), {
      cacheStatus: "hit",
      modelCalled: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      resultStatus: cached.payload.sufficiency === "insufficient" ? "insufficient" : "success",
    });
    await writeAuditSafely(store, trace);
    return json({ request_id: requestId, ...cached.payload });
  }
  trace.cacheStatus = cacheKey ? "miss" : "bypass";

  const requestLimit = positiveInteger(env.GLOBAL_DAILY_REQUEST_LIMIT, 300);
  const tokenLimit = positiveInteger(env.GLOBAL_DAILY_TOKEN_LIMIT, 300_000);
  const tokenReservation = positiveInteger(env.GLOBAL_TOKEN_RESERVATION, 8_000);
  const reservation = await store.reserveGlobalBudget({
    usageDate,
    requestLimit,
    tokenLimit,
    tokenReservation,
    nowIso,
  });
  if (!reservation.ok) {
    trace.guardrailsTriggered = [`global_${reservation.reason}_budget`];
    trace.resultStatus = "blocked_global_budget";
    await writeAuditSafely(store, trace);
    return json({ request_id: requestId, error: LIMIT_MESSAGE }, 429);
  }

  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0 };
  try {
    const client = dependencies.client || createBailianClient(env, dependencies.fetch);
    const retrieval = dependencies.retrieval || runRetrieval;
    const result = await retrieval(question, client, requirementId);
    usage = result.usage;
    await store.reconcileGlobalBudget({ usageDate, tokenReservation, usage, nowIso });
    Object.assign(trace, {
      questionType: result.questionType,
      route: result.route,
      primarySource: result.primarySource,
      additionalSource: result.additionalSource,
      additionalReason: result.additionalReason,
      modelSufficiency: result.modelSufficiency,
      finalSufficiency: result.finalSufficiency,
      guardrailsTriggered: result.guardrailsTriggered,
      validationWarnings: result.validationWarnings,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs: usage.latencyMs,
      resultStatus: result.finalSufficiency === "insufficient" ? "insufficient" : "success",
      modelCalled: true,
    });
    await writeAuditSafely(store, trace);
    // Only stable successes reach this point; upstream and validation failures throw.
    if (cacheKey) {
      await cache.write(cacheKey.url, {
        payload: groundedPayload(result),
        trace: pickCachedTrace(trace),
        cachedAt: nowIso,
        ttlSeconds: CACHE_TTL_SECONDS,
      });
    }
    return json(publicResult(requestId, result));
  } catch (error) {
    usage = error?.usage || usage;
    await store.reconcileGlobalBudget({ usageDate, tokenReservation, usage, nowIso });
    const progress = error?.retrievalTrace || {};
    Object.assign(trace, {
      questionType: progress.questionType || null,
      route: progress.route || null,
      primarySource: progress.primarySource || null,
      additionalSource: progress.additionalSource || null,
      additionalReason: progress.additionalReason || null,
      modelSufficiency: progress.modelSufficiency || null,
      guardrailsTriggered: ["fail_safe_upstream"],
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      totalTokens: usage.totalTokens || 0,
      latencyMs: usage.latencyMs || 0,
      resultStatus: "upstream_error",
      modelCalled: true,
    });
    await writeAuditSafely(store, trace);
    if (error instanceof UpstreamError) {
      return json({ request_id: requestId, error: error.publicMessage }, error.status);
    }
    return json({ request_id: requestId, error: "現在 Ask Forge を利用できません。" }, 500);
  }
}

export function methodNotAllowed() {
  return json({ error: "Method Not Allowed" }, 405);
}
