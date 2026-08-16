import assert from "node:assert/strict"

import type { Sql } from "postgres"

import { recover } from "./contract.ts"
import {
  dispatchId,
  priorCapabilityHash,
  resetFixture,
  stableRoute,
} from "./fixture.ts"

export async function assertSuccessfulRecovery(sql: Sql): Promise<void> {
  await resetFixture(sql)
  const before = await sql<{ count: number }[]>`
    select count(*)::integer as count from momi_agent_ops.dispatches`
  const first = await recover(sql)
  assert.equal(first.disposition, "recovered")
  assert.equal(first.recovered_dispatch_id, dispatchId)

  const [row] = await sql<{
    work_status: string
    attempt_count: number
    last_error_code: string | null
    capability_token_hash: string
    wake_capability_token: string | null
    dead_letter_recovery_owner_issue_identifier: string
    dead_letter_recovery_from_attempt_count: number
    dead_letter_recovery_from_error_code: string
    dead_letter_recovery_host_dispatch_url: string
  }[]>`select work_status, attempt_count, last_error_code,
    capability_token_hash, wake_capability_token,
    dead_letter_recovery_owner_issue_identifier,
    dead_letter_recovery_from_attempt_count,
    dead_letter_recovery_from_error_code,
    dead_letter_recovery_host_dispatch_url
    from momi_agent_ops.dispatches where dispatch_id = ${dispatchId}::uuid`
  assert.equal(row.work_status, "pending")
  assert.equal(row.attempt_count, 0)
  assert.equal(row.last_error_code, null)
  assert.notEqual(row.capability_token_hash, priorCapabilityHash)
  assert.match(row.capability_token_hash, /^[0-9a-f]{64}$/)
  assert.ok(row.wake_capability_token)
  assert.equal(row.dead_letter_recovery_owner_issue_identifier, "MOX-160")
  assert.equal(row.dead_letter_recovery_from_attempt_count, 8)
  assert.equal(row.dead_letter_recovery_from_error_code, "codex_host_delivery_failed")
  assert.equal(row.dead_letter_recovery_host_dispatch_url, stableRoute)

  const replay = await recover(sql)
  assert.equal(replay.disposition, "already_recovered")
  assert.equal(replay.recovery_timestamp.valueOf(), first.recovery_timestamp.valueOf())
  await assert.rejects(recover(sql, { owner: "MOX-161" }), /conflicting/)

  const after = await sql<{ count: number }[]>`
    select count(*)::integer as count from momi_agent_ops.dispatches`
  assert.equal(after[0].count, before[0].count)
}
