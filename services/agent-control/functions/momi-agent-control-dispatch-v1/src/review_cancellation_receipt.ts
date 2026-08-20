import type { Sql } from "postgres"

export type ReviewCancellationReceipt = {
  reviewer_dispatch_id: string
  capability_token: string
  host_state: "canceled"
  identities_complete: boolean
  interruption_confirmed: boolean
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseReviewCancellationReceipts(value: unknown,
  targetWorkIds: string[]): ReviewCancellationReceipt[] | null {
  if (!Array.isArray(value) || value.length > 128) return null
  const targets = new Set(targetWorkIds)
  const seen = new Set<string>()
  const receipts: ReviewCancellationReceipt[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const receipt = item as Record<string, unknown>
    const keys = Object.keys(receipt).sort().join(",")
    if (keys !== "capability_token,host_state,identities_complete,interruption_confirmed,reviewer_dispatch_id" ||
      typeof receipt.reviewer_dispatch_id !== "string" ||
      typeof receipt.capability_token !== "string" ||
      !uuid.test(receipt.reviewer_dispatch_id) || !uuid.test(receipt.capability_token) ||
      receipt.host_state !== "canceled" ||
      typeof receipt.identities_complete !== "boolean" ||
      typeof receipt.interruption_confirmed !== "boolean" ||
      (receipt.interruption_confirmed && !receipt.identities_complete) ||
      !targets.has(receipt.reviewer_dispatch_id) || seen.has(receipt.reviewer_dispatch_id)) return null
    seen.add(receipt.reviewer_dispatch_id)
    receipts.push(receipt as ReviewCancellationReceipt)
  }
  return receipts
}

export async function recordReviewCancellationReceipt(sql: Sql,
  receipt: ReviewCancellationReceipt, expectedState: string): Promise<boolean> {
  if (!["reserved", "running", "ambiguous", "changes_requested", "superseded", "canceled"]
    .includes(expectedState)) {
    return false
  }
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${receipt.reviewer_dispatch_id}::uuid, ${receipt.capability_token}::uuid,
      ${expectedState}, ${receipt.host_state}, ${receipt.identities_complete},
      ${receipt.interruption_confirmed}
    ) as recorded`
  return rows[0]?.recorded === true
}
