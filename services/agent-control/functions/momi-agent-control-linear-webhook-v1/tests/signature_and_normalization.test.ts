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

test("routes only retained discretionary and coordinator labels", () => {
  for (const action of ["execute-run", "investigate-issue",
    "run-discovery", "recover-discovery"]) {
    const payload = { action: "update", type: "Issue", webhookTimestamp: Date.now(),
      updatedFrom: { labels: [{ id: "old", name: "Feature" }] }, data: {
        labels: [{ name: action }, { name: "Feature" }] } }
    const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
    assert.equal(event?.action, action)
    assert.deepEqual(event?.changedFields, { labels: {
      before: ["Feature"], after: ["Feature", action].sort() } })
  }
})

test("retired routine action labels do not create work", () => {
  for (const action of ["cancel-run", "validate-issue", "cleanup", "decompose"]) {
    const payload = { action: "update", type: "Issue", updatedFrom: { labels: [] },
      data: { labels: [{ name: action }] } }
    assert.equal(normalizeLinearEvent(new TextEncoder().encode(
      JSON.stringify(payload)))?.action, null)
  }
})

test("escalated validation is scheduler policy and never a direct action", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { labels: [] },
    data: { labels: [{ name: "request escalated validation" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.action, null)
  assert.deepEqual(event?.changedFields, { labels: {
    before: [], after: ["request escalated validation"] } })
})

test("native Canceled is the authoritative cancellation request", () => {
  const payload = { action: "update", type: "Issue",
    updatedFrom: { stateId: "state-started" }, data: {
      stateId: "state-canceled", state: { id: "state-canceled",
        name: "Canceled", type: "canceled" }, labels: [{ name: "cancel-run" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.action, "cancel-run")
  assert.deepEqual(event?.changedFields, { state: { beforeId: "state-started",
    afterId: "state-canceled", afterName: "Canceled", afterType: "canceled" } })
})

test("captures the direct parent identity for durable child linkage", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { labels: [] },
    data: { parentId: "00000000-0000-4000-8000-000000000099",
      labels: [{ name: "execute-run" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.parentIssueId, "00000000-0000-4000-8000-000000000099")
})

test("normalizes exact decision reconciliation identities for issue and comment events", () => {
  const issue = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify({
    type: "Issue", data: { id: "00000000-0000-4000-8000-000000000010" },
  })))
  assert.equal(issue?.decisionIssueId, "00000000-0000-4000-8000-000000000010")
  const comment = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify({
    type: "Comment", data: { issue: { id: "00000000-0000-4000-8000-000000000011" } },
  })))
  assert.equal(comment?.decisionIssueId, "00000000-0000-4000-8000-000000000011")
  const unrelated = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify({
    type: "Project", data: { id: "00000000-0000-4000-8000-000000000012" },
  })))
  assert.equal(unrelated?.decisionIssueId, null)
})

test("normalizes Linear labelIds changes from the hosted webhook shape", () => {
  const payload = { action: "update", type: "Issue", webhookTimestamp: Date.now(),
    updatedFrom: { labelIds: ["feature-id"] }, data: {
      labelIds: ["action-id", "feature-id"],
      labels: [{ id: "action-id", name: "investigate-issue" },
        { id: "feature-id", name: "Feature" }] } }
  const event = normalizeLinearEvent(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(event?.action, "investigate-issue")
  assert.deepEqual(event?.changedFields, { labels: {
    before: ["Feature"], after: ["Feature", "investigate-issue"] } })

  payload.updatedFrom.labelIds = ["action-id", "feature-id"]
  assert.equal(normalizeLinearEvent(new TextEncoder().encode(
    JSON.stringify(payload)))?.action, null)
})

test("ignores an ambiguous update that adds multiple actions", () => {
  const payload = { action: "update", type: "Issue", updatedFrom: { labels: [] },
    data: { labels: [{ name: "investigate-issue" }, { name: "run-discovery" }] } }
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
