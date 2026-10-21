import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { buildRetirementSql, retirementMigration } from "../scripts/retirement_sql.ts"

const migration = await readFile(`supabase/migrations/${retirementMigration}`, "utf8")
const modulePath = process.env.MOMI_PGLITE_MODULE

test("retirement pins one canonical SQL payload without touching a ledger", () => {
  assert.equal(buildRetirementSql(migration), buildRetirementSql(migration.replaceAll("\n", "\r\n")))
  assert.throws(() => buildRetirementSql(`${migration}\nselect 1;`), /checksum_mismatch/)
  const sql = buildRetirementSql(migration)
  assert.doesNotMatch(sql, /schema_migrations|\b(?:insert|update|delete|truncate|grant|revoke)\s/i)
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;\nselect true as trigger_disabled/)
})

test("retirement wrapper preserves history and sibling triggers and fails atomically", { skip: !modulePath }, async (context) => {
  const { PGlite } = await import(pathToFileURL(modulePath!).href)
  const db = new PGlite()
  context.after(() => db.close())
  await db.exec(await readFile("tests/fixtures/retired_dispatch_trigger.sql", "utf8"))
  await db.exec(`create schema cron;
    create table cron.job (jobname text, command text, active boolean);
    insert into cron.job values ('momi-agent-control-dispatch-recovery-v1',
      'select momi_agent_ops.run_dispatch_recovery_v1()', false);`)
  const sql = buildRetirementSql(migration)
  for (const change of [
    "update cron.job set active = true",
    "update cron.job set command = 'select 1'",
    "insert into cron.job select * from cron.job",
    "delete from cron.job",
  ]) {
    await db.exec(`begin; ${change}`)
    await assert.rejects(db.exec(sql), /recovery_job_not_quiescent/)
    await db.exec("rollback")
  }
  const before = (await db.query("select * from momi_agent_ops.dispatches")).rows
  // Test-only corruption proves the wrapper rolls back after the target ALTER.
  const corrupted = sql.replace("do $retirement_after$", `alter table momi_agent_ops.dispatches disable trigger bookkeeping_sentinel;\ndo $retirement_after$`)
  await assert.rejects(db.exec(corrupted), /postcondition_failed/)
  await db.exec("rollback")
  assert.equal((await db.query("select tgenabled from pg_trigger where tgname = 'dispatch_agent_control_work'")).rows[0].tgenabled, "O")
  const results = await db.exec(sql)
  assert.deepEqual(results.at(-1).rows, [{ trigger_disabled: true, other_triggers_preserved: true }])
  assert.deepEqual((await db.query("select * from momi_agent_ops.dispatches")).rows, before)
  assert.equal((await db.query("select tgenabled from pg_trigger where tgname = 'bookkeeping_sentinel'")).rows[0].tgenabled, "O")
  await db.exec(sql)
})
