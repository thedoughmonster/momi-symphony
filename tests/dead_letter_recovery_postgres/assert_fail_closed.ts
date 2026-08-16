import assert from "node:assert/strict"

import type { Sql } from "postgres"

import { recover, type RecoveryInputs } from "./contract.ts"
import { resetFixture, type FixtureOverrides } from "./fixture.ts"

async function expectClosed(
  sql: Sql,
  fixture: FixtureOverrides,
  inputs: RecoveryInputs = {},
): Promise<void> {
  await resetFixture(sql, fixture)
  await assert.rejects(recover(sql, inputs), /recovery/)
  const [row] = await sql<{
    work_status: string
    attempt_count: number
    dead_letter_recovered_at: Date | null
  }[]>`select work_status, attempt_count, dead_letter_recovered_at
    from momi_agent_ops.dispatches`
  assert.equal(row.dead_letter_recovered_at, null)
}

export async function assertChangedStatesFailClosed(sql: Sql): Promise<void> {
  await expectClosed(sql, { hostAccepted: true })
  await expectClosed(sql, { workStatus: "active" })
  await expectClosed(sql, { terminal: true })
  await expectClosed(sql, { completed: true })
  await expectClosed(sql, { hostIdentity: true })

  await expectClosed(sql, {}, { issue: "MOX-141" })
  await expectClosed(sql, {}, { attempts: 7 })
  await expectClosed(sql, {}, { error: "different_error" })
  await expectClosed(sql, {}, {
    route: "https://other-agent-control.doh.monster/v1/dispatch",
  })

  await expectClosed(sql, { mappingActive: false })
  await expectClosed(sql, { mappingRepository: "thedoughmonster/other" })
  await expectClosed(sql, { mappingBaseBranch: "main" })
  await expectClosed(sql, {
    mappingRoute: "https://changed-agent-control.doh.monster/v1/dispatch",
  })
}
