import { handleAskRequest, methodNotAllowed } from "../_lib/service.js";

export async function onRequest(context) {
  if (context.request.method !== "POST") return methodNotAllowed();
  try {
    return await handleAskRequest(context.request, context.env);
  } catch {
    return new Response(
      JSON.stringify({
        request_id: crypto.randomUUID(),
        error: "現在 Ask Forge を利用できません。時間をおいて再度お試しください。",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      },
    );
  }
}
