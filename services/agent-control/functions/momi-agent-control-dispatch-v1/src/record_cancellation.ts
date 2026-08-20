import { getDatabase } from "../../../src/database.ts"
import type { Sql } from "postgres"
import type { DispatchInput, HostCancellation } from "./types.ts"
import { recordReviewCancellationReceipt } from "./review_cancellation_receipt.ts"

export async function recordCancellation(
  input: DispatchInput,
  result: HostCancellation,
  sql: Sql = getDatabase(),
): Promise<boolean> {
  for (const receipt of result.review_cancellations) {
    const states = await sql<{ state: string }[]>`
      select state from momi_agent_ops.review_attempts
      where reviewer_dispatch_id = ${receipt.reviewer_dispatch_id}::uuid`
    if (!states[0]?.state || !await recordReviewCancellationReceipt(
      sql, receipt, states[0].state)) return false
  }
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_cancellation_v3(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${result.cancellation_state}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
