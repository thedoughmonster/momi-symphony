import type { AgentAction } from "../../../src/actions.ts"
import type {
  LinearStatusType,
  NormalizedLinearIssue,
} from "./linear_issue_adapter.ts"

export type DispatchInput = { work_id: string; capability_token: string }

export type SchedulerPumpInput = {
  event: "scheduler_pump"
  scheduler_id: string
  release_sha: string
  active_work_ids: string[]
}

export type CancellationState = "not_requested" | "queued_cancelled" | "requested" |
  "already_terminal" | "no_target" | "operator_intervention"

export type RecoveryState = "not_requested" | "requested" | "recovered" |
  "already_archived" | "no_target" | "ambiguous_target" | "mapping_mismatch"

export type TerminalInput = DispatchInput & {
  event: "terminal"
  thread_id: string
  turn_id: string
  readiness_result: "ready" | "unready" | "failed"
  terminal_disposition: "completed" | "failed" | "interrupted"
  archived_at: string
  summary: string
  telemetry: AttemptTelemetry
}

export type LifecycleEvidenceInput = DispatchInput & {
  event: "lifecycle_evidence"
  thread_id: string
  turn_id: string
  repository: string
  base_branch: string
  branch_name: string
  pull_request_number: number
  phase: "validating" | "releasing"
  status: "pending" | "running" | "succeeded" | "failed"
  previous_revision_sha: string | null
  revision_sha: string
  merge_sha?: string
  workflow_run_id?: string
}

export type ReviewRequestInput = DispatchInput & {
  event: "review_request"
  thread_id: string
  turn_id: string
  repository: string
  base_branch: string
  branch_name: string
  pull_request_number: number
}

export type ReviewStatusInput = DispatchInput & {
  event: "review_status"
  thread_id: string
  turn_id: string
}

export type MergePreflightInput = DispatchInput & {
  event: "merge_preflight"
  thread_id: string
  turn_id: string
  repository: string
  base_branch: string
  pull_request_number: number
}

export type ReviewTerminalInput = {
  event: "review_terminal"
  reviewer_dispatch_id: string
  capability_token: string
  runtime_role: "independent_reviewer"
  thread_id: string
  turn_id: string
  review_subject: {
    implementation_dispatch_id: string
    pull_request_number: number
    head_sha: string
    base_sha: string
    generation: number
    profile: "low" | "standard" | "high"
    model: "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol"
    reasoning_effort: "low" | "medium" | "high"
    policy_version: string
  }
  review_result: null | {
    result: "accepted" | "changes_requested" | "inconclusive" | "escalate"
    findings: Array<Record<string, unknown>>
    artifact_ref: string
    result_fingerprint: string
  }
  terminal_disposition: "completed" | "failed" | "interrupted"
  archived_at: string
  telemetry: AttemptTelemetry
}

export type AttemptTelemetry = {
  policy_version: string
  stable_prefix_fingerprint: string
  context_fingerprint: string
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
  model_visible_tool_bytes: number
  model_turns: number
  no_progress_cycles: number
  subagents: number
  max_subagent_depth: number
  retries: number
  repeated_failure_fingerprints: number
  elapsed_ms: number
  disposition: "completed" | "failed" | "interrupted"
}

export type ClaimedDispatch = {
  work_id: string
  issue_id: string
  issue_identifier: string
  action: AgentAction
  source_kind: "linear_action" | "ready_leaf_scheduler" | "linear_state_cancellation"
  validation_profile: "normal" | "escalated"
  issue_url: string
  project_id: string | null
  project_name: string | null
  repository: string | null
  base_branch: string | null
  active_states: string[] | null
  host_dispatch_url: string | null
  rejection_code: "unknown_project" | null
  delivery_phase: "host" | "cancel_host" | "recover_host" | "writeback"
  parent_dispatch_id: string | null
  target_dispatch_id: string | null
  cancellation_target_ids: string[]
  cancellation_state: CancellationState
  recovery_state: RecoveryState
  thread_id: string | null
  turn_id: string | null
  linear_comment_id: string | null
}

export type HostAcceptance = { thread_id: string; turn_id: string }

export type HostCancellation = { cancellation_state: "requested" | "already_terminal" }

export type HostRecovery = { recovery_state: Exclude<RecoveryState,
  "not_requested" | "requested"> }

export type TerminalContext = {
  issue_id: string
  issue_identifier: string
  action: AgentAction
  linear_comment_id: string | null
}

export type LinearLabel = { id: string; name: string; parentName: string | null }

export type LinearWorkflowState = {
  id: string
  name: string
  type: LinearStatusType
}

export type LinearIssueState = NormalizedLinearIssue & {
  stateRef: LinearWorkflowState
  labelRefs: LinearLabel[]
  teamLabels: LinearLabel[]
  teamStates: LinearWorkflowState[]
  comments: Array<{ id: string; body: string }>
}

export type DispatchDependencies = {
  claim: (input: DispatchInput) => Promise<ClaimedDispatch | null>
  callHost: (work: ClaimedDispatch, token: string) => Promise<HostAcceptance>
  callCancel: (work: ClaimedDispatch, token: string) => Promise<HostCancellation>
  callRecovery: (work: ClaimedDispatch, token: string) => Promise<HostRecovery>
  hostAccepted: (input: DispatchInput, host: HostAcceptance) => Promise<boolean>
  cancellationRecorded: (input: DispatchInput, result: HostCancellation) => Promise<boolean>
  recoveryRecorded: (input: DispatchInput, result: HostRecovery) => Promise<boolean>
  reconcile: (work: ClaimedDispatch) => Promise<string | null>
  writeback: (input: DispatchInput, commentId: string | null) => Promise<boolean>
  retry: (input: DispatchInput, code: string) => Promise<boolean>
  project: (dispatchId: string) => Promise<unknown>
}
