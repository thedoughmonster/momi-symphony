-- service-owner: agent-control

do $disable_decision_alert$
declare
  disabled boolean;
begin
  select momi_agent_ops.disable_decision_alert_delivery_v1() into disabled;
  if disabled is distinct from true then
    raise exception 'decision_alert_disable_expected_one_route';
  end if;
end
$disable_decision_alert$;
