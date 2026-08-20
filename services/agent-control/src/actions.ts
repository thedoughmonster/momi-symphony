export const AGENT_ACTIONS = [
  "execute-run",
  "cancel-run",
  "validate-issue",
  "investigate-issue",
  "cleanup",
  "decompose",
  "run-discovery",
  "recover-discovery",
] as const

export type AgentAction = typeof AGENT_ACTIONS[number]

// These are the only labels that may still create a direct action dispatch.
// execute-run is reserved for durable parent-to-child coordination; ordinary
// implementation is created by the ready-leaf scheduler.
export const LINEAR_ACTION_LABELS = [
  "execute-run",
  "investigate-issue",
  "run-discovery",
  "recover-discovery",
] as const satisfies readonly AgentAction[]

export const ESCALATED_VALIDATION_LABEL = "request escalated validation" as const
