export const AGENT_STATE_LIFECYCLE_VERSION = "agent-state-v1" as const

export const AGENT_STATES = [
  "queued", "checking", "working", "validating", "reviewing", "releasing",
  "waiting", "failed", "stopped", "complete", "coordinating",
] as const

export type AgentState = typeof AGENT_STATES[number]
export type DeliveryEvidenceState = "not_required" | "pending" | "running" |
  "succeeded" | "failed" | "changes_requested" | "inconclusive"

export type AgentStateEvidence = {
  lifecycle_version: typeof AGENT_STATE_LIFECYCLE_VERSION
  dispatch_id: string
  current_dispatch_id: string
  action: string
  source_kind: "linear_action" | "ready_leaf_scheduler" | "linear_state_cancellation"
  work_status: "pending" | "claimed" | "writeback_pending" | "active" |
    "completed" | "cancelled" | "rejected" | "dead_letter"
  attempt_count: number
  last_error_code: string | null
  host_accepted_at: string | null
  cancellation_state: string
  cancelled_at: string | null
  readiness_result: string
  terminal_disposition: string | null
  terminal_at: string | null
  linear_writeback_at: string | null
  validation_state: DeliveryEvidenceState
  validation_sha: string | null
  review_state: DeliveryEvidenceState
  review_sha: string | null
  release_state: DeliveryEvidenceState
  release_sha: string | null
  head_sha: string | null
  merge_sha: string | null
  has_active_children: boolean
}

/** Pure lifecycle reducer. It consumes only exact-generation durable evidence. */
export function deriveAgentState(evidence: AgentStateEvidence): AgentState {
  if (evidence.lifecycle_version !== AGENT_STATE_LIFECYCLE_VERSION) {
    throw new Error("agent_state_lifecycle_version_unsupported")
  }
  if (evidence.dispatch_id !== evidence.current_dispatch_id) {
    throw new Error("agent_state_generation_stale")
  }
  exactDeliveryCorrelation(evidence)

  if (evidence.cancelled_at || evidence.work_status === "cancelled" ||
    (evidence.terminal_at && evidence.terminal_disposition === "interrupted")) return "stopped"
  if (evidence.work_status === "dead_letter" || evidence.work_status === "rejected" ||
    evidence.terminal_disposition === "failed" || evidence.readiness_result === "failed" ||
    evidence.validation_state === "failed" || evidence.review_state === "failed" ||
    evidence.release_state === "failed") return "failed"

  if (evidence.terminal_at && evidence.readiness_result === "ready" &&
    evidence.terminal_disposition === "completed" && evidence.linear_writeback_at &&
    obligationComplete(evidence.validation_state) &&
    obligationComplete(evidence.review_state) &&
    obligationComplete(evidence.release_state)) return "complete"

  if (evidence.release_state === "pending" || evidence.release_state === "running") {
    return "releasing"
  }
  if (evidence.review_state === "pending" || evidence.review_state === "running") {
    return "reviewing"
  }
  if (evidence.review_state === "inconclusive") return "waiting"
  if (evidence.validation_state === "pending" || evidence.validation_state === "running") {
    return "validating"
  }
  if (evidence.has_active_children) return "coordinating"
  if (evidence.work_status === "pending" &&
    (evidence.attempt_count > 0 || evidence.last_error_code)) return "waiting"
  if (["requested", "operator_intervention"].includes(evidence.cancellation_state)) {
    return "waiting"
  }
  if (evidence.host_accepted_at ||
    ["writeback_pending", "active", "completed"].includes(evidence.work_status)) {
    return "working"
  }
  if (evidence.work_status === "claimed") return "checking"
  return "queued"
}

function obligationComplete(state: DeliveryEvidenceState): boolean {
  return state === "not_required" || state === "succeeded"
}

function exactDeliveryCorrelation(evidence: AgentStateEvidence): void {
  if (evidence.validation_state !== "not_required" &&
    (!evidence.head_sha || evidence.validation_sha !== evidence.head_sha)) {
    throw new Error("agent_state_validation_revision_mismatch")
  }
  if (evidence.review_state !== "not_required" &&
    (!evidence.head_sha || evidence.review_sha !== evidence.head_sha)) {
    throw new Error("agent_state_review_revision_mismatch")
  }
  if (evidence.release_state !== "not_required" &&
    (!evidence.merge_sha || evidence.release_sha !== evidence.merge_sha)) {
    throw new Error("agent_state_release_revision_mismatch")
  }
}
