import { getDatabase } from "../../../src/database.ts"
import type { DispatchInput } from "./types.ts"

export async function recordLinearWriteback(
  input: DispatchInput,
  commentId: string | null,
  hasRun: boolean,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_linear_writeback_v4(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${commentId}::uuid, true, ${hasRun}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
