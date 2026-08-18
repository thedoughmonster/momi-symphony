import { getDatabase } from "../../../src/database.ts"
import type { DispatchInput, HostAcceptance } from "./types.ts"

export async function recordHostAcceptance(
  input: DispatchInput,
  host: HostAcceptance,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_host_acceptance_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${host.thread_id}, ${host.turn_id}
    ) as recorded
  `
  return rows[0]?.recorded === true
}
