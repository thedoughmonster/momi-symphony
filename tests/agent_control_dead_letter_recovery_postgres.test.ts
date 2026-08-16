import test from "node:test"

import { assertChangedStatesFailClosed } from "./dead_letter_recovery_postgres/assert_fail_closed.ts"
import { assertRecoverySecurity } from "./dead_letter_recovery_postgres/assert_security.ts"
import { assertSuccessfulRecovery } from "./dead_letter_recovery_postgres/assert_success.ts"
import { recoveryHarness } from "./dead_letter_recovery_postgres/harness.ts"

test("operator-only dead-letter recovery is exact and idempotent", async (context) => {
  const database = await recoveryHarness.start()
  context.after(() => recoveryHarness.stop(database))
  await assertRecoverySecurity(database.sql)
  await assertSuccessfulRecovery(database.sql)
  await assertChangedStatesFailClosed(database.sql)
})
