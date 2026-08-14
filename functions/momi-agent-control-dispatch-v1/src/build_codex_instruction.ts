import type { ClaimedDispatch } from "./types.ts"

export function buildCodexInstruction(work: ClaimedDispatch): string {
  return [
    `Execute Linear issue ${work.issue_identifier} directly in this visible Codex task.`,
    `Canonical issue: ${work.issue_url}`,
    `Mapped repository: ${work.repository}; base branch: ${work.base_branch}.`,
    `Before changing code, fetch the current Linear issue and relations.`,
    `Proceed only when project ${work.project_id} (${work.project_name}) still maps exactly`,
    `to that repository/base and state is one of ${(work.active_states ?? []).join(", ")}.`,
    `This dispatch is durable proof that execute-run was added; the action label is`,
    `consumed after task creation, so its absence must not make the issue unready.`,
    `Otherwise report an actionable unready result.`,
    `Follow repository AGENTS.md and the named issue's bounded scope. Use one issue branch`,
    `and draft PR; after required checks and feedback resolution, merge to ${work.base_branch}.`,
    `For hosted changes, complete the repository-authorized development release;`,
    `execute-run never authorizes production deployment or promotion; that requires`,
    `a separate explicit user instruction.`,
    `Implement the issue directly in Codex; do not hand its implementation to Symphony.`,
    `Return only the requested structured readiness/disposition summary when finished.`,
  ].join("\n")
}
