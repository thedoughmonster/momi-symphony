export type HostDispatch = {
  schema_version: 1 | 2 | 3 | 4
  work_id: string
  capability_token: string
  issue_id: string
  issue_identifier: string
  issue_url: string
  project_id: string
  project_name: string
  repository: string
  base_branch: string
  active_states: string[]
  interaction_mode: "one_shot" | "interactive"
  thread_name: string
  instruction?: string
  stable_instruction?: string
  volatile_context?: string
  stable_prefix_fingerprint?: string
  context_fingerprint?: string
  policy_version?: string
  budget?: HostExecutionBudget
  runtime_role?: "independent_reviewer"
  review_subject?: HostReviewSubject
  review_thread_id?: string
  review_workspace_id?: string
}

export type HostReviewSubject = {
  implementation_dispatch_id: string
  pull_request_number: number
  head_sha: string
  base_sha: string
  generation: number
  profile: "low" | "standard" | "high"
  model: "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol"
  reasoning_effort: "low" | "medium" | "high"
  budget_fingerprint: string
  policy_version: string
}

export type HostReviewFinding = {
  id: string
  severity: "blocking" | "nonblocking"
  category: string
  path: string
  line: number | null
  contract: string
  required_outcome: string
  evidence: string
}

export type HostReviewResult = {
  result: "accepted" | "changes_requested" | "inconclusive" | "escalate"
  findings: HostReviewFinding[]
  artifact_ref: string
  result_fingerprint: string
}

export type HostExecutionBudget = {
  model_turns: number
  no_progress_cycles: number
  subagents: number
  subagent_depth: number
  model_visible_tool_bytes: number
  elapsed_ms: number
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
  disposition: string
}

export type TerminalSummary = {
  readiness_result: "ready" | "unready" | "failed"
  terminal_disposition: "completed" | "failed" | "interrupted"
  summary: string
}

export type HostCancellation = {
  schema_version: 2
  work_id: string
  capability_token: string
  target_work_ids: string[]
  repository: string
  base_branch: string
}

export type HostCancellationResult = {
  cancellation_state: "requested" | "already_terminal"
  review_cancellations: HostReviewCancellationReceipt[]
  unmaterialized_reviewer_dispatch_ids: string[]
}

export type HostReviewCancellationReceipt = {
  reviewer_dispatch_id: string
  capability_token: string
  host_state: "canceled"
  identities_complete: boolean
  interruption_confirmed: boolean
}

export type HostRecovery = {
  schema_version: 1
  work_id: string
  capability_token: string
  target_work_id: string
}

export type HostRecoveryResult = {
  recovery_state: "recovered" | "already_archived" | "no_target" |
    "ambiguous_target" | "mapping_mismatch"
}

export type HostCancellationRecord = {
  workId: string
  fingerprint: string
  targetWorkIds: string[]
  unmaterializedReviewerDispatchIds?: string[]
  // Read compatibility for durable schema-v1 host ledgers.
  targetWorkId?: string
  state: "reserved" | "requested" | "already_terminal"
  updatedAt: string
}

export type HostRecoveryRecord = {
  workId: string
  fingerprint: string
  targetWorkId: string
  state: "reserved" | "recovered" | "already_archived"
  updatedAt: string
}

export type HostRecord = {
  workId: string
  fingerprint: string
  capabilityToken: string
  state: "reserved" | "accepted" | "interactive" | "terminal" | "ambiguous" | "canceled"
  interactionMode?: "one_shot" | "interactive"
  threadId: string | null
  turnId: string | null
  terminal: (TerminalSummary & { archivedAt: string }) | null
  callbackSent: boolean
  cancellationRequestedAt: string | null
  interruptionRequestedAt?: string | null
  interruptionConfirmedAt?: string | null
  recoveryRequestedAt?: string | null
  budget?: HostExecutionBudget
  telemetry?: AttemptTelemetry | null
  startedAt?: string
  policyVersion?: string
  stablePrefixFingerprint?: string
  contextFingerprint?: string
  runtimeRole?: "implementation" | "independent_reviewer"
  reviewSubject?: HostReviewSubject
  reviewResult?: HostReviewResult | null
  reviewWorkspaceId?: string
  reviewWorkspaceCleanedAt?: string | null
  updatedAt: string
}

export type SealedReviewCredentials = {
  version: 1
  algorithm: "aes-256-gcm"
  initializationVector: string
  authenticationTag: string
  ciphertext: string
}

export type StoredHostRecord = Omit<HostRecord,
  "capabilityToken" | "threadId" | "turnId" | "reviewSubject"> & {
  capabilityToken?: string
  threadId?: string | null
  turnId?: string | null
  reviewSubject?: HostReviewSubject
  sealedReviewCredentials?: SealedReviewCredentials
}

export type AppServerClient = {
  connect(): Promise<void>
  request<T>(method: string, params: unknown): Promise<T>
  onNotification(listener: (notification: Record<string, unknown>) => void): void
}

export type HostConfiguration = {
  workspaceRoot: string
  repository: string
  baseBranch: string
  reviewRepositoryRoot?: string
  reviewWorkspaceRoot?: string
}

export type HostAcceptance = { thread_id: string; turn_id: string }

export type TurnShape = {
  id: string
  status: "completed" | "interrupted" | "failed" | "inProgress"
  items: Array<Record<string, unknown>>
  usage?: Record<string, unknown>
}
