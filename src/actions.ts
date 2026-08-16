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
