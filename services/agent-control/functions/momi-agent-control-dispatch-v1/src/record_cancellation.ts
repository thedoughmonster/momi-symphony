import { getDatabase } from "../../../src/database.ts"
import type { Sql } from "postgres"
import type { DispatchInput, HostCancellation } from "./types.ts"

export async function recordCancellation(
  input: DispatchInput,
  result: HostCancellation,
  sql: Sql = getDatabase(),
): Promise<boolean> {
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_cancellation_v3(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${result.cancellation_state}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
