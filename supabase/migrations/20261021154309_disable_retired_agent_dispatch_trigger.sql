-- service-owner: agent-control

-- Apply through the owner private-ledger workflow after operational quiescence.
-- Preserve dispatch history and all bookkeeping/serialization triggers.
set local lock_timeout = '2s';
set local statement_timeout = '10s';
lock table momi_agent_ops.project_mappings, momi_agent_ops.scheduler_route_policies,
  momi_agent_ops.decision_alert_policies, momi_agent_ops.scheduler_leaders,
  momi_agent_ops.dispatches, momi_agent_ops.run_records,
  momi_agent_ops.scheduler_slots, momi_agent_ops.review_attempts,
  momi_agent_ops.decision_delivery_work in share row exclusive mode;

do $$
begin
  if exists (select 1 from momi_agent_ops.project_mappings where active)
    or exists (select 1 from momi_agent_ops.scheduler_route_policies where mode <> 'disabled')
    or exists (select 1 from momi_agent_ops.decision_alert_policies where mode <> 'disabled')
    or exists (select 1 from momi_agent_ops.dispatches
      where work_status in ('pending', 'claimed', 'writeback_pending'))
    or exists (select 1 from momi_agent_ops.dispatches d
      left join momi_agent_ops.run_records r on r.dispatch_id = d.dispatch_id
      where (d.host_accepted_at is not null or d.work_status = 'active')
        and r.terminal_at is null)
    or exists (select 1 from momi_agent_ops.scheduler_slots
      where state in ('reserved', 'running', 'quarantined'))
    or exists (select 1 from momi_agent_ops.scheduler_leaders where lease_expires_at > now())
    or exists (select 1 from momi_agent_ops.review_attempts where state = 'pending')
    or exists (select 1 from momi_agent_ops.decision_delivery_work
      where work_status in ('pending', 'claimed', 'retryable')) then
    raise exception 'legacy_workflow_not_quiescent';
  end if;
  if not exists (select 1 from pg_trigger
    where tgrelid = 'momi_agent_ops.dispatches'::regclass
      and tgname = 'dispatch_agent_control_work' and not tgisinternal
      and tgfoid = 'momi_agent_ops.wake_agent_control_dispatch()'::regprocedure) then
    raise exception 'legacy_dispatch_trigger_identity_mismatch';
  end if;
end
$$;

alter table momi_agent_ops.dispatches disable trigger dispatch_agent_control_work;
