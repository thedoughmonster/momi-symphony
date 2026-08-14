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

test("normalizes only a newly added execute-run label from updatedFrom", () => {
  const payload = { action: "update", type: "Issue", webhookTimestamp: Date.now(),
    webhookId: "00000000-0000-4000-8000-000000000010",
    url: "https://linear.app/x/issue/MOX-151/x", updatedFrom: {
      labels: [{ id: "old", name: "Feature" }] }, data: {
      id: "00000000-0000-4000-8000-000000000011", identifier: "MOX-151",
      project: { id: "00000000-0000-4000-8000-000000000012",
        name: "Backend Stabilization" },
      labels: [{ name: "execute-run" }, { name: "Feature" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.executeRunAdded, true)
  assert.deepEqual(event?.changedFields, { labels: {
    before: ["Feature"], after: ["Feature", "execute-run"] } })
})

test("normalizes Linear labelIds changes from the hosted webhook shape", () => {
  const payload = { action: "update", type: "Issue", webhookTimestamp: Date.now(),
    updatedFrom: { labelIds: ["feature-id"] }, data: {
      labelIds: ["execute-id", "feature-id"],
      labels: [{ id: "execute-id", name: "execute-run" },
        { id: "feature-id", name: "Feature" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.executeRunAdded, true)
  assert.deepEqual(event?.changedFields, { labels: {
    before: ["Feature"], after: ["Feature", "execute-run"] } })

  payload.updatedFrom.labelIds = ["execute-id", "feature-id"]
  assert.equal(normalizeLinearEvent(new TextEncoder().encode(
    JSON.stringify(payload)))?.executeRunAdded, false)
})

test("does not infer a change from the post-update issue object", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { title: "old" },
    data: { labels: [{ name: "execute-run" }] } }
  assert.equal(normalizeLinearEvent(new TextEncoder().encode(
    JSON.stringify(payload)))?.executeRunAdded, false)
  assert.equal(normalizeLinearEvent(new Uint8Array([255])), null)
})
