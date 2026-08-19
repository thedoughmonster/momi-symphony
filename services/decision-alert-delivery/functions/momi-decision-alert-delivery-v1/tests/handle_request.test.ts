import assert from "node:assert/strict"
import test from "node:test"

import { handleRequestWithDependencies as handleRequest } from
  "../src/handle_request_with_dependencies.ts"
import type { ClaimedDecisionDelivery, SlackDeliveryOutcome } from "../src/types.ts"

const input = {
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    secret: "private-token",
    databaseConfigured: true,
    preflight: () => Promise.resolve({ route_mode: "disabled" as const,
      destination_configured: false, release_configured: false }),
    claim: () => Promise.resolve(null),
    deliver: () => Promise.resolve({ outcome: "delivered", http_status: 200,
      retry_after_seconds: null, slack_channel_id: "C0BGPEE4A4V",
      slack_message_ts: "1787128000.1", error_code: null } as SlackDeliveryOutcome),
    finalize: () => Promise.resolve(true),
    ...overrides,
  }
}

test("GET is a no-send secret/database/policy preflight", async () => {
  const response = await handleRequest(new Request("https://example.test"), dependencies())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true, function_key: "momi.slack.decision_alert.deliver.v1",
    secret_configured: true, database_configured: true,
    route_mode: "disabled", destination_configured: false,
    release_configured: false, send_enabled: false,
  })
  const unavailable = await handleRequest(new Request("https://example.test"),
    dependencies({ secret: "" }))
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).secret_configured, false)
})

test("invalid capability input is rejected before claim", async () => {
  let claims = 0
  const response = await handleRequest(new Request("https://example.test", {
    method: "POST", body: JSON.stringify({ ...input, extra: true }),
  }), dependencies({ claim: () => { claims += 1; return Promise.resolve(null) } }))
  assert.equal(response.status, 400)
  assert.equal(claims, 0)
})

test("claim precedes Slack I/O and finalize records the provider disposition", async () => {
  const events: string[] = []
  const claimed = { attempt_id: "00000000-0000-4000-8000-000000000003" } as ClaimedDecisionDelivery
  const outcome = { outcome: "ambiguous", http_status: null, retry_after_seconds: null,
    slack_channel_id: null, slack_message_ts: null,
    error_code: "slack_request_ambiguous" } as SlackDeliveryOutcome
  const response = await handleRequest(new Request("https://example.test", {
    method: "POST", body: JSON.stringify(input),
  }), dependencies({
    claim: () => { events.push("claim"); return Promise.resolve(claimed) },
    deliver: () => { events.push("deliver"); return Promise.resolve(outcome) },
    finalize: (_input: unknown, attempt: string, actual: SlackDeliveryOutcome) => {
      events.push(`finalize:${attempt}:${actual.outcome}`); return Promise.resolve(true)
    },
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: false, disposition: "ambiguous" })
  assert.deepEqual(events, ["claim", "deliver",
    "finalize:00000000-0000-4000-8000-000000000003:ambiguous"])
})
