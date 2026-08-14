import { getDatabase } from "../../../src/database.ts"
import type { WebhookDisposition, WebhookRecord } from "./types.ts"

export async function recordWebhook(record: WebhookRecord): Promise<WebhookDisposition> {
  const sql = getDatabase()
  const rows = await sql<WebhookDisposition[]>`
    select disposition, dispatch_id::text
    from momi_agent_ops.accept_linear_webhook_v2(
      ${record.deliveryId}::uuid, ${record.webhookId}::uuid,
      ${record.rawBodyHex}, ${sql.json(record.payload)}::jsonb,
      ${record.authResult}, ${record.eventType}, ${record.eventAction},
      ${record.issueId}::uuid, ${record.issueIdentifier}, ${record.issueUrl},
      ${record.projectId}::uuid, ${record.projectName}, ${record.action},
      ${sql.json(record.changedFields)}::jsonb
    )
  `
  if (!rows[0]) throw new Error("linear_webhook_accept_failed")
  return rows[0]
}
