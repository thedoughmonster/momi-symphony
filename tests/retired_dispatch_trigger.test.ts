import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { validateOwnedMigrationSql } from "../scripts/symphony_migrations.ts"

const filename = "20261021154309_disable_retired_agent_dispatch_trigger.sql"
const migration = await readFile(`supabase/migrations/${filename}`, "utf8")
const modulePath = process.env.MOMI_PGLITE_MODULE

test("retirement migration remains within owner scope", () => {
  validateOwnedMigrationSql(filename, migration)
  const locks = migration.match(/lock table([\s\S]*?)in share row exclusive mode/)?.[1] ?? ""
  for (const table of ["project_mappings", "scheduler_route_policies", "decision_alert_policies", "scheduler_leaders"]) {
    assert.ok(locks.includes(`momi_agent_ops.${table}`), `guarded control table must be locked: ${table}`)
  }
})

test("only a quiescent workflow can disable its exact wake trigger", { skip: !modulePath }, async (context) => {
  const { PGlite } = await import(pathToFileURL(modulePath!).href)
  const db = new PGlite()
  context.after(() => db.close())
  await db.exec(await readFile("tests/fixtures/retired_dispatch_trigger.sql", "utf8"))
  for (const change of [
    "update momi_agent_ops.project_mappings set active = true",
    "update momi_agent_ops.scheduler_route_policies set mode = 'enabled'",
    "update momi_agent_ops.decision_alert_policies set mode = 'enabled'",
    "update momi_agent_ops.run_records set terminal_at = null",
    "delete from momi_agent_ops.run_records",
    "update momi_agent_ops.dispatches set work_status = 'active', host_accepted_at = null; update momi_agent_ops.run_records set terminal_at = null",
    ...["pending", "claimed", "writeback_pending"].map((state) =>
      `update momi_agent_ops.dispatches set work_status = '${state}'`),
    ...["reserved", "running", "quarantined"].map((state) =>
      `insert into momi_agent_ops.scheduler_slots values ('${state}')`),
    "insert into momi_agent_ops.scheduler_leaders values (now() + interval '1 hour')",
    "insert into momi_agent_ops.review_attempts values ('pending')",
    ...["pending", "claimed", "retryable"].map((state) =>
      `insert into momi_agent_ops.decision_delivery_work values ('${state}')`),
  ]) {
    await db.exec(`begin; ${change}`)
    await assert.rejects(db.exec(migration), /not_quiescent/, change)
    await db.exec("rollback")
  }
  for (const change of [
    "alter trigger dispatch_agent_control_work on momi_agent_ops.dispatches rename to other_trigger",
    `drop trigger dispatch_agent_control_work on momi_agent_ops.dispatches;
      create trigger dispatch_agent_control_work after insert on momi_agent_ops.dispatches
        for each row execute function momi_agent_ops.bookkeeping_sentinel()`,
  ]) {
    await db.exec(`begin; ${change}`)
    await assert.rejects(db.exec(migration), /identity_mismatch/)
    await db.exec("rollback")
  }
  const before = (await db.query("select * from momi_agent_ops.dispatches")).rows
  const runsBefore = (await db.query("select * from momi_agent_ops.run_records")).rows
  await db.exec(`begin; ${migration} commit;`)
  assert.deepEqual((await db.query("select * from momi_agent_ops.dispatches")).rows, before)
  assert.deepEqual((await db.query("select * from momi_agent_ops.run_records")).rows, runsBefore)
  assert.deepEqual((await db.query(`select tgname, tgenabled from pg_trigger
    where tgrelid='momi_agent_ops.dispatches'::regclass and not tgisinternal order by tgname`)).rows,
  [{ tgname: "bookkeeping_sentinel", tgenabled: "O" },
    { tgname: "dispatch_agent_control_work", tgenabled: "D" }])
  await db.exec(`begin; ${migration} commit;`)
  assert.deepEqual((await db.query("select * from momi_agent_ops.dispatches")).rows, before)
  assert.deepEqual((await db.query("select * from momi_agent_ops.run_records")).rows, runsBefore)
})
