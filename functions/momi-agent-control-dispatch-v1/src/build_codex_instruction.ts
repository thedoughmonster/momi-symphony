import type { ClaimedDispatch } from "./types.ts"

export function buildCodexInstruction(work: ClaimedDispatch): string {
  return [
    `Execute Linear issue ${work.issue_identifier} directly in this visible Codex task.`,
    `Canonical issue: ${work.issue_url}`,
    `Mapped repository: ${work.repository}; base branch: ${work.base_branch}.`,
    `Before changing code, fetch the current Linear issue and relations.`,
    `Proceed only when project ${work.project_id} (${work.project_name}) still maps exactly`,
    `to that repository/base, state is one of ${(work.active_states ?? []).join(", ")},`,
    `and execute-run is still present. Otherwise report an actionable unready result.`,
    `Follow repository AGENTS.md, use one issue branch and draft PR, and do not merge or deploy.`,
    `Do not invoke Symphony. Do not implement other action labels, parent runs, or cancellation.`,
    `Return only the requested structured readiness/disposition summary when finished.`,
  ].join("\n")
}
