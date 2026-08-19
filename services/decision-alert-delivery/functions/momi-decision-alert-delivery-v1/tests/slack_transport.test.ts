import assert from "node:assert/strict"
import test from "node:test"

import { buildSlackText, deliverToSlack } from "../src/slack_transport.ts"
import type { ClaimedDecisionDelivery } from "../src/types.ts"

function work(kind: "initial" | "resolution" = "initial"): ClaimedDecisionDelivery {
  return {
    attempt_id: "00000000-0000-4000-8000-000000000001",
    work_id: "00000000-0000-4000-8000-000000000002",
    delivery_kind: kind,
    decision_identity: "linear:issue:comment:mox-232-acceptance",
    issue_identifier: "MOX-232",
    issue_title: "Send deduplicated Slack alerts",
    issue_url: "https://linear.app/moxx-workboard/issue/MOX-232/example",
    category: "material_architecture_ownership",
    question: "Should acceptance use the governed development alerts destination?",
    policy_gap: "Repository policy cannot select the operator-owned destination.",
    recommendation: "Use the existing disabled development alerts destination.",
    alternatives: ["Stop before delivery", "Create a new authorized destination"],
    consequences: ["One development alert", "Production remains untouched"],
    affected_issue_identifiers: ["MOX-232"],
    resolution_summary: kind === "resolution" ? "Use the governed development alerts channel." : null,
    slack_channel_id: "C0BGPEE4A4V",
    slack_thread_ts: kind === "resolution" ? "1787128000.000100" : null,
  }
}

test("success sends a bounded no-mention payload to the exact destination", async () => {
  let request: RequestInit | undefined
  const result = await deliverToSlack(work(), "private-token", async (_url, init) => {
    request = init
    return Response.json({ ok: true, channel: "C0BGPEE4A4V", ts: "1787128000.000100" })
  })
  assert.deepEqual(result, { outcome: "delivered", http_status: 200,
    retry_after_seconds: null, slack_channel_id: "C0BGPEE4A4V",
    slack_message_ts: "1787128000.000100", error_code: null })
  const payload = JSON.parse(String(request?.body))
  assert.equal(payload.channel, "C0BGPEE4A4V")
  assert.equal(payload.mrkdwn, false)
  assert.equal(payload.parse, "none")
  assert.doesNotMatch(payload.text, /<!channel>|<!here>|<@[A-Z0-9]+>/i)
  assert.match(payload.text, /Question:/)
  assert.match(payload.text, /Recommendation:/)
  assert.match(payload.text, /Alternatives:/)
  assert.match(payload.text, /Consequences:/)
  assert.match(payload.text, /Affected issues: MOX-232/)
  assert.doesNotMatch(JSON.stringify(payload), /private-token/)
})

test("429 is the only retryable provider fixture and honors Retry-After", async () => {
  const result = await deliverToSlack(work(), "private-token", async () =>
    new Response("rate limited", { status: 429, headers: { "Retry-After": "17" } }))
  assert.deepEqual(result, { outcome: "retryable", http_status: 429,
    retry_after_seconds: 17, slack_channel_id: null, slack_message_ts: null,
    error_code: "slack_rate_limited" })
})

test("network, server, malformed, and mismatched receipt outcomes are ambiguous", async () => {
  const fixtures: Array<() => Promise<Response>> = [
    () => Promise.reject(new Error("connection reset")),
    () => Promise.resolve(new Response("upstream", { status: 503 })),
    () => Promise.resolve(new Response("not json", { status: 200 })),
    () => Promise.resolve(Response.json({ ok: true, channel: "COTHER", ts: "1787128000.1" })),
  ]
  for (const fixture of fixtures) {
    assert.equal((await deliverToSlack(work(), "private-token", fixture)).outcome, "ambiguous")
  }
})

test("resolution posts exactly one bounded reply to the recorded thread", async () => {
  let payload: Record<string, unknown> = {}
  const result = await deliverToSlack(work("resolution"), "private-token", async (_url, init) => {
    payload = JSON.parse(String(init?.body))
    return Response.json({ ok: true, channel: "C0BGPEE4A4V", ts: "1787128001.000200" })
  })
  assert.equal(result.outcome, "delivered")
  assert.equal(payload.thread_ts, "1787128000.000100")
  assert.match(String(payload.text), /Decision resolved in Linear/)
  assert.match(buildSlackText(work("resolution")), /Resolution:/)
})
