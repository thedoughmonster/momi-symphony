import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { recordCancellation } from "../src/record_cancellation.ts"

const reviewerId = "00000000-0000-4000-8000-000000000011"
const reviewerToken = "00000000-0000-4000-8000-000000000012"
const input = { work_id: "00000000-0000-4000-8000-000000000013",
  capability_token: "00000000-0000-4000-8000-000000000014" }
const receipt = { reviewer_dispatch_id: reviewerId, capability_token: reviewerToken,
  host_state: "canceled" as const, identities_complete: false,
  interruption_confirmed: false }

test("records authenticated reviewer cancellation receipts before parent completion", async () => {
  const timeline: string[] = []
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("select state from")) return [{ state: "ambiguous" }]
    if (query.includes("record_review_cancellation_receipt_v1")) {
      timeline.push("review-receipt"); return [{ recorded: true }]
    }
    if (query.includes("record_cancellation_v3")) {
      timeline.push("parent-cancellation"); return [{ recorded: true }]
    }
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  assert.equal(await recordCancellation(input, {
    cancellation_state: "requested", review_cancellations: [receipt],
  }, sql), true)
  assert.deepEqual(timeline, ["review-receipt", "parent-cancellation"])
})

test("fails closed before parent completion when a reviewer receipt is refused", async () => {
  let parentRecorded = false
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("select state from")) return [{ state: "ambiguous" }]
    if (query.includes("record_review_cancellation_receipt_v1")) return [{ recorded: false }]
    parentRecorded = true; return [{ recorded: true }]
  }) as unknown as Sql
  assert.equal(await recordCancellation(input, {
    cancellation_state: "requested", review_cancellations: [receipt],
  }, sql), false)
  assert.equal(parentRecorded, false)
})
