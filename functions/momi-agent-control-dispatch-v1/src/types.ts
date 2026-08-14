export type DispatchInput = { work_id: string; capability_token: string }

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
  issue_url: string
  project_id: string | null
  project_name: string | null
  repository: string | null
  base_branch: string | null
  active_states: string[] | null
  rejection_code: "unknown_project" | null
  delivery_phase: "host" | "writeback"
  thread_id: string | null
  turn_id: string | null
  linear_comment_id: string | null
}

export type HostAcceptance = { thread_id: string; turn_id: string }

export type TerminalContext = {
  issue_id: string
  issue_identifier: string
  linear_comment_id: string | null
}

export type LinearLabel = { id: string; name: string }

export type LinearIssueState = {
  id: string
  identifier: string
  state: string
  labels: LinearLabel[]
  teamLabels: LinearLabel[]
  comments: Array<{ id: string; body: string }>
}

export type DispatchDependencies = {
  claim: (input: DispatchInput) => Promise<ClaimedDispatch | null>
  callHost: (work: ClaimedDispatch, token: string) => Promise<HostAcceptance>
  hostAccepted: (input: DispatchInput, host: HostAcceptance) => Promise<boolean>
  reconcile: (work: ClaimedDispatch) => Promise<string | null>
  writeback: (input: DispatchInput, commentId: string | null,
    hasRun: boolean) => Promise<boolean>
  retry: (input: DispatchInput, code: string) => Promise<boolean>
}
