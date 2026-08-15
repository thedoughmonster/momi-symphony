export type HostDispatch = {
  schema_version: 1 | 2
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
  instruction: string
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

export type HostCancellationRecord = {
  workId: string
  fingerprint: string
  targetWorkId: string
  state: "reserved" | "requested" | "already_terminal"
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
}
