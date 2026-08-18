-- service-owner: agent-control

create function momi_agent_ops.wake_agent_control_dispatch()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  route_path constant text := '/functions/v1/momi-agent-control-dispatch-v1';
  project_url text;
  gateway_key text;
begin
  if new.wake_capability_token is null or new.work_status <> 'pending'
    or new.next_attempt_at > now() then return new; end if;
  select decrypted_secret into project_url from vault.decrypted_secrets
    where name = 'momi_project_url';
  select decrypted_secret into gateway_key from vault.decrypted_secrets
    where name = 'momi_publishable_key';
  if project_url is null or gateway_key is null then return new; end if;
  perform net.http_post(
    url := rtrim(project_url, '/') || route_path,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', gateway_key),
    body := jsonb_build_object('work_id', new.dispatch_id::text,
      'capability_token', new.wake_capability_token::text),
    timeout_milliseconds := 5000
  );
  update momi_agent_ops.dispatches work set wake_capability_token = null
    where work.dispatch_id = new.dispatch_id
      and work.wake_capability_token = new.wake_capability_token;
  return new;
end;
$$;

create trigger dispatch_agent_control_work
after insert or update of wake_capability_token on momi_agent_ops.dispatches
for each row execute function momi_agent_ops.wake_agent_control_dispatch();

select cron.schedule(
  'momi-agent-control-dispatch-recovery-v1', '30 seconds',
  'select momi_agent_ops.run_dispatch_recovery_v1()'
);

revoke all on function momi_agent_ops.wake_agent_control_dispatch()
  from public, anon, authenticated;
