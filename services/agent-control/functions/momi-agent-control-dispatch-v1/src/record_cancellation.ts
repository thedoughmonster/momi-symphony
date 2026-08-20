import { getDatabase } from "../../../src/database.ts"
import type { DispatchInput, HostCancellation } from "./types.ts"

export async function recordCancellation(
  input: DispatchInput,
  result: HostCancellation,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_cancellation_v2(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${result.cancellation_state}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
