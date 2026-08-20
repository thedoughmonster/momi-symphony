import type { AgentAction } from "./actions.ts"

export const EXECUTION_POLICY_VERSION = "mox-execution-efficiency-v1" as const

export type ActionBudget = {
  model_turns: number
  no_progress_cycles: number
  subagents: number
  subagent_depth: number
  model_visible_tool_bytes: number
  elapsed_ms: number
}

export type ContextSource = {
  identity: string
  fingerprint: string
  reason: string
  required: boolean
}

export type ActionContextEnvelope = {
  schema_version: 1
  policy_version: typeof EXECUTION_POLICY_VERSION
  action: AgentAction
  issue: { id: string; identifier: string; url: string }
  mapping: { project_id: string; project_name: string; repository: string; base_branch: string }
  active_states: string[]
  sources: ContextSource[]
  attempt_delta: { dispatch_id: string; durable_action_evidence: true }
}

const BUDGETS: Record<AgentAction, ActionBudget> = {
  "execute-run": { model_turns: 64, no_progress_cycles: 2, subagents: 3,
    subagent_depth: 1, model_visible_tool_bytes: 96_000, elapsed_ms: 7_200_000 },
  "run-discovery": { model_turns: 32, no_progress_cycles: 3, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 48_000, elapsed_ms: 7_200_000 },
  "investigate-issue": { model_turns: 24, no_progress_cycles: 2, subagents: 2,
    subagent_depth: 1, model_visible_tool_bytes: 64_000, elapsed_ms: 1_800_000 },
  "decompose": { model_turns: 16, no_progress_cycles: 2, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 48_000, elapsed_ms: 1_200_000 },
  "validate-issue": { model_turns: 8, no_progress_cycles: 1, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 24_000, elapsed_ms: 600_000 },
  "cleanup": { model_turns: 8, no_progress_cycles: 1, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 24_000, elapsed_ms: 600_000 },
  "cancel-run": { model_turns: 0, no_progress_cycles: 0, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 0, elapsed_ms: 60_000 },
  "recover-discovery": { model_turns: 0, no_progress_cycles: 0, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 0, elapsed_ms: 60_000 },
}

export const NO_MODEL_OPERATIONS = [
  "readiness", "scheduling", "dependency_reconciliation", "ci_polling",
  "cancellation", "cleanup_routing", "recovery_routing", "slack_deduplication",
  "retry_classification",
] as const

export function budgetForAction(action: AgentAction): ActionBudget {
  return { ...BUDGETS[action] }
}

export function stableFingerprint(value: unknown): string {
  const text = stableJson(value)
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function buildActionContextEnvelope(input: {
  action: AgentAction; work_id: string; issue_id: string; issue_identifier: string
  issue_url: string; project_id: string; project_name: string
  repository: string; base_branch: string; active_states: string[]
}): ActionContextEnvelope {
  const source = (identity: string, reason: string): ContextSource => ({ identity,
    fingerprint: stableFingerprint(identity), reason, required: true })
  const sources = [
    source(`linear:issue:${input.issue_id}`, "current bounded issue snapshot"),
    source(`linear:relations:${input.issue_id}`, "native parent, child, and blocker preflight"),
    source(`linear:project:${input.project_id}`, "canonical project mapping verification"),
    source(`repo:${input.repository}@${input.base_branch}:AGENTS.md`,
      "applicable repository authority and delivery rules"),
  ]
  if (["execute-run", "investigate-issue"].includes(input.action)) {
    sources.push(source(`repo:${input.repository}:services/agent-control/AGENTS.md`,
      "owning control-plane service rules"))
    sources.push(source(`repo:${input.repository}:services/agent-control-host/AGENTS.md`,
      "owning host transport rules"))
  }
  return { schema_version: 1, policy_version: EXECUTION_POLICY_VERSION,
    action: input.action,
    issue: { id: input.issue_id, identifier: input.issue_identifier, url: input.issue_url },
    mapping: { project_id: input.project_id, project_name: input.project_name,
      repository: input.repository, base_branch: input.base_branch },
    active_states: [...input.active_states], sources,
    attempt_delta: { dispatch_id: input.work_id, durable_action_evidence: true } }
}
