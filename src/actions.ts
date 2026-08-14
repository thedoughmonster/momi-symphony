export const AGENT_ACTIONS = [
  "execute-run",
  "validate-issue",
  "investigate-issue",
  "cleanup",
  "decompose",
  "run-discovery",
] as const

export type AgentAction = typeof AGENT_ACTIONS[number]
