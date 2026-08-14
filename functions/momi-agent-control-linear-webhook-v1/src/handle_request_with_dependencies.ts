import { normalizeLinearEvent } from "./normalize_linear_event.ts"
import { rawBodyHex } from "./raw_body_hex.ts"
import { recordWebhook } from "./record_webhook.ts"
import type { IngressDependencies } from "./types.ts"
import { verifyLinearSignature } from "./verify_linear_signature.ts"

const deliveryPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function handleRequestWithDependencies(
  request: Request,
  injected?: IngressDependencies,
): Promise<Response> {
  const secret = injected?.secret ?? Deno.env.get("LINEAR_WEBHOOK_SECRET")?.trim() ?? ""
  if (request.method === "GET") {
    return Response.json({ ok: Boolean(secret),
      function_key: "momi.agent_control.linear_webhook.v1" })
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  const rawBody = new Uint8Array(await request.arrayBuffer())
  if (rawBody.length < 2 || rawBody.length > 131_072) {
    return new Response("invalid request size", { status: 413 })
  }
  const deliveryId = request.headers.get("linear-delivery")
  if (!deliveryPattern.test(deliveryId ?? "")) {
    return new Response("invalid delivery identity", { status: 400 })
  }
  const normalized = normalizeLinearEvent(rawBody)
  const verified = await verifyLinearSignature(
    rawBody, request.headers.get("linear-signature"), secret,
  )
  const now = injected?.now() ?? Date.now()
  const fresh = normalized?.webhookTimestamp !== null &&
    Math.abs(now - normalized!.webhookTimestamp!) <= 60_000
  const authResult = !verified ? "signature_failed" : !normalized
    ? "invalid_payload" : !fresh ? "stale" : "verified"
  const empty = { payload: {}, webhookId: null, webhookTimestamp: null,
    eventType: null, eventAction: null, issueId: null, issueIdentifier: null,
    issueUrl: null, projectId: null, projectName: null,
    action: null, changedFields: {} } as const
  try {
    const result = await (injected?.persist ?? recordWebhook)({
      ...(normalized ?? empty), deliveryId: deliveryId!, rawBodyHex: rawBodyHex(rawBody),
      authResult,
    })
    const status = authResult === "verified" ? 200
      : authResult === "invalid_payload" ? 400 : 401
    return Response.json({ ok: status === 200, disposition: result.disposition }, { status })
  } catch (error) {
    console.error("Linear webhook persistence failed", deliveryId,
      error instanceof Error ? error.message : "unknown")
    return Response.json({ ok: false, disposition: "retrying" }, { status: 503 })
  }
}
