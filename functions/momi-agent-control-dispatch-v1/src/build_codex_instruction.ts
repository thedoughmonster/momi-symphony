import type { AgentAction } from "../../../src/actions.ts"
import type { ClaimedDispatch } from "./types.ts"

const actionInstructions: Record<AgentAction, string[]> = {
  "execute-run": [
    "Follow repository AGENTS.md and the named issue's bounded scope. Use one issue branch",
    "and draft PR; after required checks and feedback resolution, merge to the mapped base.",
    "For hosted changes, complete the repository-authorized development release.",
    "Implement the issue directly in Codex.",
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
    "Run bounded discovery for the issue and record findings, open questions, and next work.",
    "Do not implement, change repository files, or create a branch or PR.",
  ],
}

export function buildCodexInstruction(work: ClaimedDispatch): string {
  return [
    `Perform Linear action ${work.action} for issue ${work.issue_identifier} in this visible task.`,
    `Canonical issue: ${work.issue_url}`,
    `Mapped repository: ${work.repository}; base branch: ${work.base_branch}.`,
    "Before acting, fetch the current Linear issue and relations.",
    `Proceed only when project ${work.project_id} (${work.project_name}) still maps exactly`,
    `to that repository/base and state is one of ${(work.active_states ?? []).join(", ")}.`,
    `This dispatch is durable proof that ${work.action} was added; the action label is`,
    "consumed after task creation, so its absence must not make the issue unready.",
    "Otherwise report an actionable unready result.",
    ...actionInstructions[work.action],
    "Never invoke Symphony for this action.",
    "No action authorizes production deployment or promotion without separate explicit approval.",
    "Return only the requested structured readiness/disposition summary when finished.",
  ].join("\n")
}
