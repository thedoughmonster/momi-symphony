import { createHash } from "node:crypto"
import type { HostDispatch } from "./types.ts"

export function dispatchFingerprint(dispatch: HostDispatch): string {
  const common = { active_states: [...dispatch.active_states].sort(),
    base_branch: dispatch.base_branch,
    issue_id: dispatch.issue_id, issue_identifier: dispatch.issue_identifier,
    issue_url: dispatch.issue_url, project_id: dispatch.project_id,
    project_name: dispatch.project_name, repository: dispatch.repository,
    schema_version: dispatch.schema_version, work_id: dispatch.work_id }
  const canonical = JSON.stringify(dispatch.schema_version === 3
    ? { ...common, interaction_mode: dispatch.interaction_mode,
      thread_name: dispatch.thread_name, budget: dispatch.budget,
      stable_instruction: dispatch.stable_instruction,
      volatile_context: dispatch.volatile_context,
      stable_prefix_fingerprint: dispatch.stable_prefix_fingerprint,
      context_fingerprint: dispatch.context_fingerprint,
      policy_version: dispatch.policy_version }
    : dispatch.schema_version === 2
    ? { ...common, interaction_mode: dispatch.interaction_mode,
      thread_name: dispatch.thread_name, instruction: dispatch.instruction }
    : { ...common, instruction: dispatch.instruction })
  return createHash("sha256").update(canonical).digest("hex")
}
