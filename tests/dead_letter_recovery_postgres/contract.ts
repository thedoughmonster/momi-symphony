import type { Sql } from "postgres"

import { dispatchId, stableRoute } from "./fixture.ts"

export type RecoveryInputs = {
  dispatch?: string
  issue?: string
  attempts?: number
  error?: string
  route?: string
  owner?: string
}

export type RecoveryResult = {
  disposition: string
  recovered_dispatch_id: string
  recovery_timestamp: Date
}

export async function recover(
  sql: Sql,
  inputs: RecoveryInputs = {},
): Promise<RecoveryResult> {
  const rows = await sql<RecoveryResult[]>`
    select * from momi_agent_ops.recover_dead_letter_dispatch_v1(
      ${inputs.dispatch ?? dispatchId}::uuid,
      ${inputs.issue ?? "MOX-140"},
      ${inputs.attempts ?? 8},
      ${inputs.error ?? "codex_host_delivery_failed"},
      ${inputs.route ?? stableRoute},
      ${inputs.owner ?? "MOX-160"}
    )`
  if (rows.length !== 1) throw new Error("Recovery returned an unexpected row count")
  return rows[0]
}
