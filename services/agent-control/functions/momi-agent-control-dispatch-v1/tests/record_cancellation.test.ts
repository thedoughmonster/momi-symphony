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

test("replays a receipt-persisted cancellation without changing reviewer authority", async () => {
  const receipts: unknown[][] = []; let currentState = "reserved"; let parentCalls = 0
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?")
    if (query.includes("select state from")) return [{ state: currentState }]
    if (query.includes("record_review_cancellation_receipt_v1")) {
      receipts.push([values[2], values[4], values[5]])
      currentState = "canceled"; return [{ recorded: true }]
    }
    if (query.includes("record_cancellation_v3")) {
      parentCalls += 1
      if (parentCalls === 1) throw new Error("simulated_parent_recording_crash")
      return [{ recorded: true }]
    }
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  const result = { cancellation_state: "requested" as const,
    review_cancellations: [receipt] }
  await assert.rejects(recordCancellation(input, result, sql),
    /simulated_parent_recording_crash/)
  const enrichedResult = { cancellation_state: "requested" as const,
    review_cancellations: [{ ...receipt, identities_complete: true,
      interruption_confirmed: true }] }
  assert.equal(await recordCancellation(input, enrichedResult, sql), true)
  assert.deepEqual(receipts, [
    ["reserved", false, false],
    ["canceled", true, true],
  ])
  assert.equal(parentCalls, 2)
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
