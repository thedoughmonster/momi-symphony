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
}

export type ClaimedDispatch = {
  work_id: string
  issue_id: string
  issue_identifier: string
  action: AgentAction
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

export type LinearLabel = { id: string; name: string }

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
  writeback: (input: DispatchInput, commentId: string | null,
    hasRun: boolean) => Promise<boolean>
  retry: (input: DispatchInput, code: string) => Promise<boolean>
}
