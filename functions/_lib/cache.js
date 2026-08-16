// Ask Forge runtime response cache v0.1 (Cloudflare Cache API, no extra service).
// Only server-derived inputs form the key: the browser can never steer model,
// prompt version, or context revision, so a poisoned entry cannot be requested.

export const CACHE_VERSION = "askforge-cache-v0.1";
export const CACHE_TTL_SECONDS = 86_400;

const CACHE_NAMESPACE = "ask-forge-runtime";
const CACHE_PATH = "__ask-forge-cache";

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeQuestion(question) {
  return String(question ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// The key URL stays on the request origin: Cloudflare only caches same-zone keys.
// The path is never routed, it exists solely as a cache identity.
export async function buildCacheKey({ origin, requirementId, question, contextRevision, promptVersion, model }) {
  const material = JSON.stringify([
    CACHE_VERSION,
    String(requirementId ?? ""),
    normalizeQuestion(question),
    String(contextRevision ?? ""),
    String(promptVersion ?? ""),
    String(model ?? ""),
  ]);
  const digest = await sha256Hex(material);
  return { url: `${origin}/${CACHE_PATH}/${CACHE_VERSION}/${digest}`, digest };
}

function isCacheableRecord(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.route !== "string" || typeof payload.sufficiency !== "string") return false;
  if (typeof payload.answer !== "string") return false;
  return ["retrieved_sources", "evidence", "impact_items", "human_authority"].every((field) =>
    Array.isArray(payload[field]),
  );
}

async function resolveCache(cacheStorage) {
  if (!cacheStorage) return null;
  if (cacheStorage.default) return cacheStorage.default;
  if (typeof cacheStorage.open === "function") return await cacheStorage.open(CACHE_NAMESPACE);
  return null;
}

// Every cache failure degrades to a MISS: correctness never depends on the cache.
export function createRuntimeCache(cacheStorage = globalThis.caches) {
  return {
    async read(keyUrl) {
      try {
        const cache = await resolveCache(cacheStorage);
        if (!cache) return null;
        const hit = await cache.match(new Request(keyUrl, { method: "GET" }));
        if (!hit) return null;
        const record = await hit.json();
        return isCacheableRecord(record) ? record : null;
      } catch {
        return null;
      }
    },

    async write(keyUrl, record) {
      try {
        const cache = await resolveCache(cacheStorage);
        if (!cache || !isCacheableRecord(record)) return false;
        await cache.put(
          new Request(keyUrl, { method: "GET" }),
          new Response(JSON.stringify(record), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
            },
          }),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
