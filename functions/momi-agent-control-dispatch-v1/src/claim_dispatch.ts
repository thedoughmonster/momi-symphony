import { getDatabase } from "../../../src/database.ts"
import type { ClaimedDispatch, DispatchInput } from "./types.ts"

export async function claimDispatch(input: DispatchInput): Promise<ClaimedDispatch | null> {
  const sql = getDatabase()
  const rows = await sql<ClaimedDispatch[]>`
    select work_id::text, issue_id::text, issue_identifier, action, issue_url,
      project_id::text, project_name, repository, base_branch, active_states,
      host_dispatch_url, rejection_code, delivery_phase, thread_id, turn_id,
      linear_comment_id::text
    from momi_agent_ops.claim_dispatch_v3(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    )
  `
  return rows[0] ?? null
}
