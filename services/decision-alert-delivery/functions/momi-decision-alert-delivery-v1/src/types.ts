export type DeliveryInput = { work_id: string; capability_token: string }

export type ClaimedDecisionDelivery = {
  attempt_id: string
  work_id: string
  delivery_kind: "initial" | "resolution"
  decision_identity: string
  issue_identifier: string
  issue_title: string
  issue_url: string
  category: string
  question: string
  policy_gap: string
  recommendation: string
  alternatives: string[]
  consequences: string[]
  affected_issue_identifiers: string[]
  resolution_summary: string | null
  slack_channel_id: string
  slack_thread_ts: string | null
}

export type SlackDeliveryOutcome = {
  outcome: "delivered" | "retryable" | "ambiguous" | "failed"
  http_status: number | null
  retry_after_seconds: number | null
  slack_channel_id: string | null
  slack_message_ts: string | null
  error_code: string | null
}
