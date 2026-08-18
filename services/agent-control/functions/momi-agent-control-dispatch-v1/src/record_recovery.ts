import { getDatabase } from "../../../src/database.ts"
import type { DispatchInput, HostRecovery } from "./types.ts"

export async function recordRecovery(
  input: DispatchInput,
  result: HostRecovery,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_recovery_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${result.recovery_state}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
