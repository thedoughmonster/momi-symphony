export type HostDispatch = {
  schema_version: 1 | 2 | 3
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
  schema_version: 1
  work_id: string
  capability_token: string
  target_work_id: string
  repository: string
  base_branch: string
}

export type HostCancellationResult = {
  cancellation_state: "requested" | "already_terminal"
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
  targetWorkId: string
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
  state: "reserved" | "accepted" | "interactive" | "terminal" | "ambiguous"
  interactionMode?: "one_shot" | "interactive"
  threadId: string | null
  turnId: string | null
  terminal: (TerminalSummary & { archivedAt: string }) | null
  callbackSent: boolean
  cancellationRequestedAt: string | null
  recoveryRequestedAt?: string | null
  budget?: HostExecutionBudget
  telemetry?: AttemptTelemetry | null
  startedAt?: string
  policyVersion?: string
  stablePrefixFingerprint?: string
  contextFingerprint?: string
  updatedAt: string
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
}

export type HostAcceptance = { thread_id: string; turn_id: string }

export type TurnShape = {
  id: string
  status: "completed" | "interrupted" | "failed" | "inProgress"
  items: Array<Record<string, unknown>>
  usage?: Record<string, unknown>
}
