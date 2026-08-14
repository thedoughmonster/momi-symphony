import { createHash } from "node:crypto"
import type { HostDispatch } from "./types.ts"

export function dispatchFingerprint(dispatch: HostDispatch): string {
  const canonical = JSON.stringify({ active_states: [...dispatch.active_states].sort(),
    base_branch: dispatch.base_branch, instruction: dispatch.instruction,
    issue_id: dispatch.issue_id, issue_identifier: dispatch.issue_identifier,
    issue_url: dispatch.issue_url, project_id: dispatch.project_id,
    project_name: dispatch.project_name, repository: dispatch.repository,
    schema_version: dispatch.schema_version, work_id: dispatch.work_id })
  return createHash("sha256").update(canonical).digest("hex")
}
