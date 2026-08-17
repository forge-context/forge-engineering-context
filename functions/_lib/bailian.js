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

export class MalformedModelResponseError extends UpstreamError {
  constructor() {
    super("malformed_model_json", "回答を安全に検証できませんでした。時間をおいて再度お試しください。", 502);
    this.name = "MalformedModelResponseError";
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

      let payload;
      try {
        payload = await response.json();
        const content = payload.choices[0].message.content;
        const result = JSON.parse(content);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
        const usage = payload.usage || {};
        const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
        const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
        return {
          result,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: Number(usage.total_tokens ?? inputTokens + outputTokens),
          },
          latencyMs: Date.now() - started,
        };
      } catch {
        throw new MalformedModelResponseError();
      }
    },
  };
}
