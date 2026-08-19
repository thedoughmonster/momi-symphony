import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"

import { handleRequestWithDependencies as handleRequest } from
  "../src/handle_request_with_dependencies.ts"
import type { WebhookRecord } from "../src/types.ts"

test("records signature failure without accepting work", async () => {
  let recorded: WebhookRecord | null = null
  const payload = JSON.stringify({ action: "update", type: "Issue",
    webhookTimestamp: 1_000, webhookId: "00000000-0000-4000-8000-000000000001",
    updatedFrom: { labels: [] }, data: { labels: [{ name: "execute-run" }] } })
  const response = await handleRequest(new Request("https://example.test", {
    method: "POST", headers: { "linear-delivery":
      "00000000-0000-4000-8000-000000000002", "linear-signature": "0".repeat(64) },
    body: payload,
  }), { secret: "secret", now: () => 1_000,
    persist: (record) => { recorded = record
      return Promise.resolve({ disposition: "rejected", dispatch_id: null }) } })
  assert.equal(response.status, 401)
  assert.equal(recorded?.authResult, "signature_failed")
})

test("failed durable commit returns retry and creates no downstream side effect", async () => {
  const payload = JSON.stringify({ action: "update", type: "Issue",
    webhookTimestamp: 2_000, webhookId: "00000000-0000-4000-8000-000000000003",
    updatedFrom: { labels: [] }, data: { id: "00000000-0000-4000-8000-000000000004",
      identifier: "MOX-151", labels: [{ name: "execute-run" }] } })
  const signature = createHmac("sha256", "secret").update(payload).digest("hex")
  let persistenceCalls = 0
  const response = await handleRequest(new Request("https://example.test", {
    method: "POST", headers: { "linear-delivery":
      "00000000-0000-4000-8000-000000000005", "linear-signature": signature },
    body: payload,
  }), { secret: "secret", now: () => 2_000, persist: () => {
    persistenceCalls += 1; return Promise.reject(new Error("commit_failed"))
  } })
  assert.equal(response.status, 503)
  assert.equal(persistenceCalls, 1)
})

test("verified delivery exposes the durable duplicate disposition", async () => {
  const payload = JSON.stringify({ action: "update", type: "Issue",
    webhookTimestamp: 3_000, webhookId: "00000000-0000-4000-8000-000000000006",
    updatedFrom: {}, data: {} })
  const signature = createHmac("sha256", "secret").update(payload).digest("hex")
  const response = await handleRequest(new Request("https://example.test", {
    method: "POST", headers: { "linear-delivery":
      "00000000-0000-4000-8000-000000000007", "linear-signature": signature },
    body: payload,
  }), { secret: "secret", now: () => 3_000, persist: () =>
    Promise.resolve({ disposition: "duplicate", dispatch_id: null }) })
  assert.deepEqual(await response.json(), { ok: true, disposition: "duplicate" })
})

test("verified decision events reconcile after durable webhook persistence", async () => {
  const issueId = "00000000-0000-4000-8000-000000000008"
  const payload = JSON.stringify({ action: "update", type: "Comment",
    webhookTimestamp: 4_000, webhookId: "00000000-0000-4000-8000-000000000009",
    data: { issue: { id: issueId } } })
  const signature = createHmac("sha256", "secret").update(payload).digest("hex")
  const events: string[] = []
  const response = await handleRequest(new Request("https://example.test", {
    method: "POST", headers: { "linear-delivery":
      "00000000-0000-4000-8000-000000000010", "linear-signature": signature },
    body: payload,
  }), { secret: "secret", now: () => 4_000,
    persist: () => { events.push("persist"); return Promise.resolve({
      disposition: "ignored", dispatch_id: null,
    }) }, reconcileDecision: (id) => { events.push(`reconcile:${id}`); return Promise.resolve() } })
  assert.equal(response.status, 200)
  assert.deepEqual(events, ["persist", `reconcile:${issueId}`])
})
