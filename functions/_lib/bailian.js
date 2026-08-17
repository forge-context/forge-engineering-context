// Closed set of upstream failure categories that may be persisted. Anything not on
// this list — including any future or unexpected exception — is reported as
// `internal`, so an audit row can never carry an upstream message, body, or trace.
export const UPSTREAM_ERROR_KINDS = Object.freeze([
  "network",
  "timeout",
  "authentication",
  "quota",
  "api",
  "malformed_model_json",
]);

export const INTERNAL_ERROR_KIND = "internal";

export class UpstreamError extends Error {
  constructor(kind, publicMessage, status = 502) {
    super(kind);
    this.name = "UpstreamError";
    this.kind = kind;
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

export function classifyUpstreamError(error) {
  const kind = error instanceof UpstreamError ? String(error.kind ?? "") : "";
  return UPSTREAM_ERROR_KINDS.includes(kind) ? kind : INTERNAL_ERROR_KIND;
}

// Where a model response stopped being usable. Closed set: the value reaches D1,
// so it can only ever be one of these names.
//   upstream_json       the HTTP body was not JSON at all
//   upstream_shape      JSON body, but no string choices[0].message.content
//   content_json        content present but not parseable as a JSON object
//   contract_validation content parsed, but it failed the Ask Forge schema contract
export const PARSING_STAGES = Object.freeze([
  "upstream_json",
  "upstream_shape",
  "content_json",
  "contract_validation",
]);

// Upstream may report any string here, so it is mapped onto a closed set before it
// can reach the audit row. Anything unrecognised becomes `other`.
export const FINISH_REASONS = Object.freeze(["stop", "length", "content_filter", "tool_calls"]);

export function safeParsingStage(value) {
  return PARSING_STAGES.includes(value) ? value : null;
}

export function safeFinishReason(value) {
  if (value == null) return null;
  const reason = String(value);
  return FINISH_REASONS.includes(reason) ? reason : "other";
}

// Counts are the only numbers taken from an upstream payload; a missing or
// non-numeric field becomes 0 rather than propagating an arbitrary value.
function safeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function readUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = safeCount(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = safeCount(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = safeCount(usage.total_tokens ?? inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

// A malformed response still carries diagnosable facts. Only safe ones are kept:
// a stage name, a mapped finish reason, token counts and elapsed time. The raw
// content, the raw body, the prompt and the exception itself are all discarded here.
export class MalformedModelResponseError extends UpstreamError {
  constructor(diagnostics = {}) {
    super("malformed_model_json", "回答を安全に検証できませんでした。時間をおいて再度お試しください。", 502);
    this.name = "MalformedModelResponseError";
    this.parsingStage = safeParsingStage(diagnostics.stage);
    this.finishReason = safeFinishReason(diagnostics.finishReason);
    // Set only when the failing call's tokens have not been counted yet, so the
    // caller can fold them in without double counting.
    this.callUsage = diagnostics.usage
      ? {
        inputTokens: safeCount(diagnostics.usage.inputTokens),
        outputTokens: safeCount(diagnostics.usage.outputTokens),
        totalTokens: safeCount(diagnostics.usage.totalTokens),
      }
      : null;
    this.callLatencyMs = safeCount(diagnostics.latencyMs);
  }
}

export function resolveModel(env) {
  return String(env.BAILIAN_MODEL || "qwen3.7-plus").trim();
}

export function createBailianClient(env, fetchImpl = fetch) {
  const apiKey = String(env.BAILIAN_API_KEY || "").trim();
  const baseUrl = String(env.BAILIAN_BASE_URL || "").trim();
  const model = resolveModel(env);
  if (!apiKey || !baseUrl) throw new Error("Bailian configuration is incomplete");

  let endpoint;
  try {
    endpoint = `${new URL(baseUrl).toString().replace(/\/$/, "")}/chat/completions`;
  } catch {
    throw new Error("Bailian base URL is invalid");
  }

  return {
    async complete({ messages, maxTokens }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const started = Date.now();
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.1,
            max_tokens: maxTokens,
            enable_thinking: false,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new UpstreamError("timeout", "回答の生成がタイムアウトしました。", 504);
        }
        throw new UpstreamError("network", "現在 Ask Forge に接続できません。", 502);
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 401 || response.status === 403) {
        throw new UpstreamError("authentication", "Ask Forge の設定を確認しています。", 502);
      }
      if (response.status === 429) {
        throw new UpstreamError("quota", "現在 Ask Forge が混み合っています。時間をおいて再度お試しください。", 503);
      }
      if (!response.ok) {
        throw new UpstreamError("api", "現在 Ask Forge を利用できません。", 502);
      }

      // Parsed in stages so a failure records where it stopped. The body itself is
      // never re-read or retained: only the stage name, the mapped finish reason
      // and the usage counters leave this block.
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new MalformedModelResponseError({
          stage: "upstream_json",
          latencyMs: Date.now() - started,
        });
      }

      const usage = readUsage(payload);
      const finishReason = safeFinishReason(payload?.choices?.[0]?.finish_reason);
      const latencyMs = Date.now() - started;
      const diagnostics = { finishReason, usage, latencyMs };

      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new MalformedModelResponseError({ ...diagnostics, stage: "upstream_shape" });
      }

      let result;
      try {
        result = JSON.parse(content);
      } catch {
        throw new MalformedModelResponseError({ ...diagnostics, stage: "content_json" });
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new MalformedModelResponseError({ ...diagnostics, stage: "content_json" });
      }
      return { result, usage, latencyMs, finishReason };
    },
  };
}
