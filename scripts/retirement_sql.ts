import { createHash } from "node:crypto"

export const retirementMigration = "20261021154309_disable_retired_agent_dispatch_trigger.sql"
export const retirementSqlSha256 = "48d91eaecb04ed597a5c641090420a1063e97bf8c32652ff4f043cb3a5cdfa9a"

export function buildRetirementSql(source: string): string {
  // Canonical LF content is pinned; Windows checkout conversion is not a change.
  const sql = source.replaceAll("\r\n", "\n")
  if (createHash("sha256").update(sql).digest("hex") !== retirementSqlSha256) {
    throw new Error("retirement_sql_checksum_mismatch")
  }
  const guardOffset = sql.indexOf("\ndo $$")
  if (guardOffset < 0) throw new Error("retirement_sql_structure_mismatch")
  const snapshot = `select coalesce(jsonb_agg(
    case when tgname = 'dispatch_agent_control_work' then to_jsonb(t) - 'tgenabled'
      else to_jsonb(t) end order by oid), '[]'::jsonb)
    from pg_catalog.pg_trigger t
    where tgrelid = 'momi_agent_ops.dispatches'::regclass`
  return `begin;
${sql.slice(0, guardOffset)}
do $retirement_before$
begin
  if (select count(*) from cron.job
      where jobname = 'momi-agent-control-dispatch-recovery-v1'
        and command = 'select momi_agent_ops.run_dispatch_recovery_v1()'
        and not active) <> 1
    or (select count(*) from cron.job
      where jobname = 'momi-agent-control-dispatch-recovery-v1') <> 1 then
    raise exception 'retirement_recovery_job_not_quiescent';
  end if;
  perform set_config('momi_retirement.trigger_snapshot', (${snapshot})::text, true);
end
$retirement_before$;
${sql.slice(guardOffset)}
do $retirement_after$
begin
  if not exists (select 1 from pg_catalog.pg_trigger
      where tgrelid = 'momi_agent_ops.dispatches'::regclass
        and tgname = 'dispatch_agent_control_work' and not tgisinternal
        and tgfoid = 'momi_agent_ops.wake_agent_control_dispatch()'::regprocedure
        and tgenabled = 'D')
    or current_setting('momi_retirement.trigger_snapshot')::jsonb
      is distinct from (${snapshot}) then
    raise exception 'retirement_trigger_postcondition_failed';
  end if;
end
$retirement_after$;
commit;
select true as trigger_disabled, true as other_triggers_preserved;
`
}
