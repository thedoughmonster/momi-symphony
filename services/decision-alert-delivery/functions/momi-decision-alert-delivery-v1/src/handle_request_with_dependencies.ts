import { claimDelivery } from "./claim_delivery.ts"
import { finalizeDelivery } from "./finalize_delivery.ts"
import { parseDeliveryInput } from "./parse_delivery_input.ts"
import { readPreflight } from "./preflight.ts"
import { deliverToSlack } from "./slack_transport.ts"
import type { ClaimedDecisionDelivery, DeliveryInput, SlackDeliveryOutcome } from "./types.ts"

type Dependencies = {
  secret: string
  databaseConfigured: boolean
  preflight: typeof readPreflight
  claim: (input: DeliveryInput) => Promise<ClaimedDecisionDelivery | null>
  deliver: (work: ClaimedDecisionDelivery, token: string) => Promise<SlackDeliveryOutcome>
  finalize: typeof finalizeDelivery
}

export async function handleRequestWithDependencies(
  request: Request,
  injected?: Dependencies,
): Promise<Response> {
  const secret = injected?.secret ?? Deno.env.get("SLACK_BOT_TOKEN")?.trim() ?? ""
  const databaseConfigured = injected?.databaseConfigured ??
    Boolean(Deno.env.get("SUPABASE_DB_URL")?.trim())
  const preflight = injected?.preflight ?? readPreflight
  if (request.method === "GET") {
    try {
      const policy = await preflight()
      const ready = Boolean(secret && databaseConfigured)
      return Response.json({ ok: ready, function_key: "momi.slack.decision_alert.deliver.v1",
        secret_configured: Boolean(secret), database_configured: databaseConfigured,
        route_mode: policy.route_mode,
        destination_configured: policy.destination_configured,
        release_configured: policy.release_configured,
        send_enabled: policy.route_mode !== "disabled" }, { status: ready ? 200 : 503 })
    } catch {
      return Response.json({ ok: false, function_key: "momi.slack.decision_alert.deliver.v1",
        secret_configured: Boolean(secret), database_configured: databaseConfigured,
        send_enabled: false }, { status: 503 })
    }
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  const input = parseDeliveryInput(await request.json().catch(() => null))
  if (!input) return new Response("invalid request", { status: 400 })
  try {
    const work = await (injected?.claim ?? claimDelivery)(input)
    if (!work) return Response.json({ ok: true, disposition: "no_work" })
    const outcome = await (injected?.deliver ?? deliverToSlack)(work, secret)
    const recorded = await (injected?.finalize ?? finalizeDelivery)(input, work.attempt_id, outcome)
    if (!recorded) throw new Error("decision_delivery_finalize_failed")
    return Response.json({ ok: outcome.outcome === "delivered",
      disposition: outcome.outcome })
  } catch (error) {
    console.error("Decision alert delivery failed",
      error instanceof Error ? error.message : "decision_delivery_unknown")
    return Response.json({ ok: false, disposition: "failed" }, { status: 503 })
  }
}
