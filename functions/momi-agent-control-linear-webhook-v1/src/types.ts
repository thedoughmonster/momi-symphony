import type { JSONValue } from "postgres"

import type { AgentAction } from "../../../src/actions.ts"

export type LabelChange = { before: string[]; after: string[] }

export type NormalizedLinearEvent = {
  payload: Record<string, JSONValue>
  webhookId: string | null
  webhookTimestamp: number | null
  eventType: string | null
  eventAction: string | null
  issueId: string | null
  issueIdentifier: string | null
  issueUrl: string | null
  projectId: string | null
  projectName: string | null
  action: AgentAction | null
  changedFields: { labels: LabelChange } | Record<string, never>
}

export type WebhookRecord = NormalizedLinearEvent & {
  deliveryId: string
  rawBodyHex: string
  authResult: "verified" | "signature_failed" | "stale" | "invalid_payload"
}

export type WebhookDisposition = {
  disposition: "accepted" | "duplicate" | "ignored" | "rejected"
  dispatch_id: string | null
}

export type IngressDependencies = {
  secret: string
  now: () => number
  persist: (record: WebhookRecord) => Promise<WebhookDisposition>
}
