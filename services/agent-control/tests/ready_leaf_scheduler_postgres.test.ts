import test from "node:test"

import { assertContentionAndRecovery, assertDefaultAndReleaseFencing,
  assertGenerationRefreshAndStaleLeader, assertHeartbeatAcceptanceLockOrder,
  assertTransactionalAcceptanceRollback } from "./ready_leaf_scheduler_postgres/assert_scheduler.ts"
import { assertSchedulerSecurity } from "./ready_leaf_scheduler_postgres/assert_security.ts"
import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

test("ready-leaf scheduling is private, fenced, atomic, and restart-safe", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  await assertSchedulerSecurity(database.sql)
  await assertDefaultAndReleaseFencing(database.sql, database.url)
  await assertTransactionalAcceptanceRollback(database.sql)
  await assertContentionAndRecovery(database.sql)
  await assertHeartbeatAcceptanceLockOrder(database.sql, database.url)
  await assertGenerationRefreshAndStaleLeader(database.sql)
})
