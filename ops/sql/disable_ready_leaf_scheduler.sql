-- service-owner: agent-control

do $disable_scheduler$
declare
  affected integer;
begin
  update momi_agent_ops.scheduler_route_policies policy set
    mode = 'disabled',
    acceptance_issue_ids = '{}'::uuid[],
    updated_at = now()
  where policy.repository = 'thedoughmonster/momi-symphony'
    and policy.base_branch = 'main';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'ready_leaf_scheduler_disable_expected_one_route:%', affected;
  end if;
end
$disable_scheduler$;
