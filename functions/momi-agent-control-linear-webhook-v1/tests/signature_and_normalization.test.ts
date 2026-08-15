import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"

import { normalizeLinearEvent } from "../src/normalize_linear_event.ts"
import { verifyLinearSignature } from "../src/verify_linear_signature.ts"

test("verifies the exact raw Linear bytes", async () => {
  const raw = new TextEncoder().encode('{"action":"update", "type":"Issue"}')
  const signature = createHmac("sha256", "linear-secret").update(raw).digest("hex")
  assert.equal(await verifyLinearSignature(raw, signature, "linear-secret"), true)
  assert.equal(await verifyLinearSignature(new TextEncoder().encode(
    '{"action":"update","type":"Issue"}'), signature, "linear-secret"), false)
  assert.equal(await verifyLinearSignature(raw, "00", "linear-secret"), false)
})

test("routes each newly added declared action from updatedFrom", () => {
  for (const action of ["execute-run", "cancel-run", "validate-issue", "investigate-issue",
    "cleanup", "decompose", "run-discovery"]) {
    const payload = { action: "update", type: "Issue", webhookTimestamp: Date.now(),
      updatedFrom: { labels: [{ id: "old", name: "Feature" }] }, data: {
        labels: [{ name: action }, { name: "Feature" }] } }
    const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
    assert.equal(event?.action, action)
    assert.deepEqual(event?.changedFields, { labels: {
      before: ["Feature"], after: ["Feature", action].sort() } })
  }
})

test("captures the direct parent identity for durable child linkage", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { labels: [] },
    data: { parentId: "00000000-0000-4000-8000-000000000099",
      labels: [{ name: "execute-run" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.parentIssueId, "00000000-0000-4000-8000-000000000099")
})

test("normalizes Linear labelIds changes from the hosted webhook shape", () => {
  const payload = { action: "update", type: "Issue", webhookTimestamp: Date.now(),
    updatedFrom: { labelIds: ["feature-id"] }, data: {
      labelIds: ["action-id", "feature-id"],
      labels: [{ id: "action-id", name: "decompose" },
        { id: "feature-id", name: "Feature" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.action, "decompose")
  assert.deepEqual(event?.changedFields, { labels: {
    before: ["Feature"], after: ["Feature", "decompose"] } })

  payload.updatedFrom.labelIds = ["action-id", "feature-id"]
  assert.equal(normalizeLinearEvent(new TextEncoder().encode(
    JSON.stringify(payload)))?.action, null)
})

test("ignores an ambiguous update that adds multiple actions", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { labels: [] },
    data: { labels: [{ name: "cleanup" }, { name: "run-discovery" }] } }
  assert.equal(normalizeLinearEvent(new TextEncoder().encode(
    JSON.stringify(payload)))?.action, null)
})

test("does not infer a change from the post-update issue object", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { title: "old" },
    data: { labels: [{ name: "execute-run" }] } }
  assert.equal(normalizeLinearEvent(new TextEncoder().encode(
    JSON.stringify(payload)))?.action, null)
  assert.equal(normalizeLinearEvent(new Uint8Array([255])), null)
})
