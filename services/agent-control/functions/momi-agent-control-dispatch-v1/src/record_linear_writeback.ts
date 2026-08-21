import { getDatabase } from "../../../src/database.ts"
import type { DispatchInput } from "./types.ts"

export async function recordLinearWriteback(
  input: DispatchInput,
  commentId: string | null,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_linear_writeback_v6(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${commentId}::uuid
    ) as recorded
  `
  return rows[0]?.recorded === true
}
