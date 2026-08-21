import { getDatabase } from "../../../src/database.ts"
import type { DispatchInput } from "./types.ts"

export async function retryDispatch(input: DispatchInput, code: string): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ retried: boolean }[]>`
    select momi_agent_ops.retry_dispatch_v2(
      ${input.work_id}::uuid, ${input.capability_token}::uuid, ${code}
    ) as retried
  `
  return rows[0]?.retried === true
}
