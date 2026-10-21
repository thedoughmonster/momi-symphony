import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { buildRetirementSql, retirementMigration } from "../../scripts/retirement_sql.ts"
import { schedulerHarness } from "../../services/agent-control/tests/ready_leaf_scheduler_postgres/harness.ts"

test("retirement on the full historical schema is guarded, bounded, atomic and replay-safe", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const sql = await database.sql.reserve()
  const competitor = await database.sql.reserve()
  const retirement = buildRetirementSql(await readFile(`supabase/migrations/${retirementMigration}`, "utf8"))
  try {
    await sql.unsafe(`create table cron.job (jobname text, command text, active boolean);
      insert into cron.job values ('momi-agent-control-dispatch-recovery-v1',
        'select momi_agent_ops.run_dispatch_recovery_v1()', false);`)
    await assert.rejects(sql.unsafe(retirement), /legacy_workflow_not_quiescent/)
    await sql.unsafe("rollback")
    await sql.unsafe(`update momi_agent_ops.project_mappings set active = false;
      update momi_agent_ops.scheduler_route_policies set mode = 'disabled';
      update momi_agent_ops.decision_alert_policies set mode = 'disabled';
      insert into momi_agent_ops.raw_webhook_envelopes
        (delivery_id, raw_body, payload, payload_sha256, auth_result)
        values ('40000000-0000-4000-8000-000000000001', decode('7b7d', 'hex'),
          '{}'::jsonb, repeat('0', 64), 'verified');
      insert into momi_agent_ops.dispatches (dispatch_id, receipt_delivery_id,
        idempotency_key, linear_issue_id, linear_issue_identifier, linear_issue_url,
        action, changed_fields, work_status, capability_token_hash, host_accepted_at)
        values ('40000000-0000-4000-8000-000000000002',
          '40000000-0000-4000-8000-000000000001', 'retirement-history-fixture',
          '40000000-0000-4000-8000-000000000003', 'FIXTURE-1',
          'https://linear.app/fixture/issue/FIXTURE-1', 'execute-run', '{}'::jsonb,
          'completed', repeat('1', 64), '2000-01-01T00:00:00Z');
      insert into momi_agent_ops.run_records (dispatch_id, terminal_at, terminal_disposition)
        values ('40000000-0000-4000-8000-000000000002',
          '2000-01-01T00:01:00Z', 'completed');`)
    const dispatches = await sql`select * from momi_agent_ops.dispatches order by dispatch_id`
    const runs = await sql`select * from momi_agent_ops.run_records order by dispatch_id`
    const triggers = await sql`select tgname, to_jsonb(t) as attributes from pg_trigger t
      where tgrelid = 'momi_agent_ops.dispatches'::regclass order by tgname`

    await competitor.unsafe("begin; lock table momi_agent_ops.project_mappings in row exclusive mode")
    await assert.rejects(sql.unsafe(retirement), { code: "55P03" })
    await sql.unsafe("rollback")
    await competitor.unsafe("rollback")

    const corrupted = retirement.replace("do $retirement_after$",
      "alter table momi_agent_ops.dispatches disable trigger serialize_dispatch_generation_v1;\ndo $retirement_after$")
    await assert.rejects(sql.unsafe(corrupted), /retirement_trigger_postcondition_failed/)
    await sql.unsafe("rollback")
    assert.deepEqual(await sql`select tgname, to_jsonb(t) as attributes from pg_trigger t
      where tgrelid = 'momi_agent_ops.dispatches'::regclass order by tgname`, triggers)

    for (let attempt = 0; attempt < 2; attempt++) {
      await sql.unsafe(retirement)
      const actual = await sql`select tgname, to_jsonb(t) as attributes from pg_trigger t
        where tgrelid = 'momi_agent_ops.dispatches'::regclass order by tgname`
      assert.deepEqual(Array.from(actual), triggers.map((trigger) => ({ ...trigger,
        attributes: trigger.tgname === 'dispatch_agent_control_work'
          ? { ...trigger.attributes, tgenabled: 'D' } : trigger.attributes })))
      assert.deepEqual(await sql`select * from momi_agent_ops.dispatches order by dispatch_id`, dispatches)
      assert.deepEqual(await sql`select * from momi_agent_ops.run_records order by dispatch_id`, runs)
    }
  } finally {
    await sql.unsafe("rollback").catch(() => undefined)
    await competitor.unsafe("rollback").catch(() => undefined)
    sql.release()
    competitor.release()
  }
})
