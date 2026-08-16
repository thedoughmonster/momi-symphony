import assert from "node:assert/strict"

import type { Sql } from "postgres"

import { recover, type RecoveryInputs } from "./contract.ts"
import { resetFixture, type FixtureOverrides } from "./fixture.ts"

const failClosed = {
  async expect(
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
  },
}

export async function assertChangedStatesFailClosed(sql: Sql): Promise<void> {
  await failClosed.expect(sql, { hostAccepted: true })
  await failClosed.expect(sql, { workStatus: "active" })
  await failClosed.expect(sql, { terminal: true })
  await failClosed.expect(sql, { completed: true })
  await failClosed.expect(sql, { hostIdentity: true })

  await failClosed.expect(sql, {}, { issue: "MOX-141" })
  await failClosed.expect(sql, {}, { attempts: 7 })
  await failClosed.expect(sql, {}, { error: "different_error" })
  await failClosed.expect(sql, {}, {
    route: "https://other-agent-control.doh.monster/v1/dispatch",
  })

  await failClosed.expect(sql, { mappingActive: false })
  await failClosed.expect(sql, { mappingRepository: "thedoughmonster/other" })
  await failClosed.expect(sql, { mappingBaseBranch: "main" })
  await failClosed.expect(sql, {
    mappingRoute: "https://changed-agent-control.doh.monster/v1/dispatch",
  })
}
