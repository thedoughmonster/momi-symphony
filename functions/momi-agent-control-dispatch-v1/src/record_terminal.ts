import { getDatabase } from "../../../src/database.ts"
import type { TerminalContext, TerminalInput } from "./types.ts"

export async function recordTerminal(input: TerminalInput): Promise<TerminalContext | null> {
  const sql = getDatabase()
  const rows = await sql<TerminalContext[]>`
    select issue_id::text, issue_identifier, linear_comment_id::text
    from momi_agent_ops.record_terminal_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${input.thread_id}, ${input.turn_id}, ${input.readiness_result},
      ${input.terminal_disposition}, ${input.summary}, ${input.archived_at}::timestamptz
    )
  `
  return rows[0] ?? null
}
