import { getDatabase } from "./database.ts"
import type { DeliveryInput, SlackDeliveryOutcome } from "./types.ts"

export async function finalizeDelivery(
  input: DeliveryInput,
  attemptId: string,
  outcome: SlackDeliveryOutcome,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.finalize_decision_delivery_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${attemptId}::uuid, ${outcome.outcome}, ${outcome.http_status},
      ${outcome.retry_after_seconds}, ${outcome.slack_channel_id},
      ${outcome.slack_message_ts}, ${outcome.error_code}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
