import { getDatabase } from "../../../src/database.ts"
import type { LifecycleEvidenceInput } from "./types.ts"

export async function recordLifecycleEvidence(
  input: LifecycleEvidenceInput,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_lifecycle_evidence_v3(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${input.thread_id}, ${input.turn_id}, ${input.repository}, ${input.base_branch},
      ${input.branch_name}, ${input.pull_request_number}, ${input.phase}, ${input.status},
      ${input.previous_revision_sha}, ${input.revision_sha}, ${input.merge_sha ?? null},
      ${input.workflow_run_id ?? null}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
