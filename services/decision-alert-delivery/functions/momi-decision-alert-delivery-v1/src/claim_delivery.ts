import { getDatabase } from "./database.ts"
import type { ClaimedDecisionDelivery, DeliveryInput } from "./types.ts"

export async function claimDelivery(input: DeliveryInput): Promise<ClaimedDecisionDelivery | null> {
  const sql = getDatabase()
  const rows = await sql<ClaimedDecisionDelivery[]>`
    select attempt_id::text, work_id::text, delivery_kind, decision_identity,
      issue_identifier, issue_title, issue_url, category, question, policy_gap,
      recommendation, alternatives, consequences, affected_issue_identifiers,
      resolution_summary, slack_channel_id, slack_thread_ts
    from momi_agent_ops.claim_decision_delivery_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    )
  `
  return rows[0] ?? null
}
