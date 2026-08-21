import type { AgentAction } from "../../../src/actions.ts"
import { buildActionContextEnvelope, stableFingerprint, stableJson } from "../../../src/execution_efficiency.ts"
import type { ClaimedDispatch } from "./types.ts"

const actionInstructions: Record<AgentAction, string[]> = {
  "execute-run": [
    "Follow repository AGENTS.md and the named issue's bounded scope.",
    "When the issue has no direct children, implement it with one issue branch and draft PR;",
    "after required checks and feedback resolution, submit one authenticated merge request",
    "for the exact head. That request evaluates current review authority and all configured",
    "merge blockers once under the shared lock, then merges the exact SHA only if eligible.",
    "When direct children exist, act as their visible parent coordinator instead of implementing",
    "the parent: inspect the bounded child graph, deterministically preflight each child, and add",
    "execute-run once to each eligible child. Never re-dispatch a child carrying this parent's",
    "durable run evidence. Monitor child terminal comments and report aggregate progress, partial",
    "failure, retry, and operator-intervention needs on the parent issue.",
    "For hosted changes, complete the repository-authorized development release.",
  ],
  "cancel-run": [
    "Do not implement or create a task. Reconcile the durable cancellation result in Linear.",
  ],
  "validate-issue": [
    "Perform only a deterministic readiness check and produce an actionable Linear response.",
    "Do not implement, change repository files, or create a branch or PR.",
  ],
  "investigate-issue": [
    "Perform a bounded, evidence-backed investigation and report findings without implementing.",
    "Do not change repository files or create a branch or PR by default.",
  ],
  "cleanup": [
    "Repair only Linear metadata and stale run bookkeeping within the issue's bounded scope.",
    "Runtime and session cleanup remains automatic; do not implement.",
  ],
  "decompose": [
    "Propose or create executable child issues in Linear with bounded scope and acceptance.",
    "Do not implement the children or change repository files.",
  ],
  "run-discovery": [
    "This is a persistent interactive discovery task, not a one-shot report.",
    "Orient from the issue and bounded evidence, then ask one concise high-value question.",
    "Continue across user turns and refine Linear only after the user confirms decisions.",
    "Only when the current user explicitly asks to finalize this discovery into Linear,",
    "use $linear-finalize-discovery for that planning-only operation. Never infer finalization",
    "from silence, elapsed time, turn completion, task retention, or task archive.",
    "Finalization keeps this task open and cannot create or start implementation work.",
    "Do not dump raw findings, implement, change repository files, or create a branch or PR.",
  ],
  "recover-discovery": [
    "Do not create a task. Recover only the exact retained discovery identity.",
  ],
}

export type CodexPrompt = {
  stablePrefix: string
  volatileContext: string
  stablePrefixFingerprint: string
  contextFingerprint: string
}

export function buildCodexPrompt(work: ClaimedDispatch): CodexPrompt {
  const stablePrefix = [
    `Perform Linear action ${work.action} in this visible task.`,
    "Before acting, fetch the current Linear issue and relations.",
    "Proceed only when the volatile context's project still maps exactly to its",
    "repository/base and state remains in the declared active states.",
    `This dispatch is durable proof that ${work.action} was selected. An operator-facing`,
    "action label is not required and its absence must not make the issue unready.",
    "Otherwise report an actionable unready result.",
    ...actionInstructions[work.action],
    ...(work.action === "execute-run" && work.validation_profile === "escalated" ? [
      "Apply the repository's escalated validation profile to this execution lifecycle.",
      "If that profile cannot be resolved exactly, report unready instead of downgrading it.",
    ] : []),
    "Never invoke Symphony for this action.",
    "No action authorizes production deployment or promotion without separate explicit approval.",
    work.action === "run-discovery"
      ? "Respond conversationally; the task remains open for the user's next message."
      : "Return only the requested structured readiness/disposition summary when finished.",
  ].join("\n")
  const envelope = buildActionContextEnvelope({ ...work,
    project_id: work.project_id!, project_name: work.project_name!,
    repository: work.repository!, base_branch: work.base_branch!,
    active_states: work.active_states ?? [], validation_profile: work.validation_profile })
  const volatileContext = [
    "Volatile action context (authoritative for this attempt):",
    `Durable dispatch: ${work.work_id}.`,
    stableJson(envelope),
  ].join("\n")
  return { stablePrefix, volatileContext,
    stablePrefixFingerprint: stableFingerprint(stablePrefix),
    contextFingerprint: stableFingerprint(envelope) }
}

export function buildCodexInstruction(work: ClaimedDispatch): string {
  const prompt = buildCodexPrompt(work)
  return `${prompt.stablePrefix}\n${prompt.volatileContext}`
}
