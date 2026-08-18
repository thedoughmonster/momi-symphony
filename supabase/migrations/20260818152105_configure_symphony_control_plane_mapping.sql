-- service-owner: agent-control

do $$
declare
  source_active_states text[];
  source_host_dispatch_url text;
begin
  select mapping.active_states, mapping.host_dispatch_url
  into strict source_active_states, source_host_dispatch_url
  from momi_agent_ops.project_mappings mapping
  where mapping.linear_project_name = 'Backend Stabilization'
    and mapping.active;

  if source_host_dispatch_url is null or
    source_host_dispatch_url !~ '^https://' then
    raise exception 'symphony_mapping_host_url_missing';
  end if;

  insert into momi_agent_ops.project_mappings (
    linear_project_id,
    linear_project_name,
    repository,
    base_branch,
    active_states,
    active,
    host_dispatch_url
  ) values (
    'de0dbcdb-9025-4ccc-8b3c-56f23d7367d5',
    'Symphony Control Plane',
    'thedoughmonster/momi-symphony',
    'main',
    source_active_states,
    true,
    source_host_dispatch_url
  )
  on conflict (linear_project_id) do update set
    linear_project_name = excluded.linear_project_name,
    repository = excluded.repository,
    base_branch = excluded.base_branch,
    active_states = excluded.active_states,
    active = excluded.active,
    host_dispatch_url = excluded.host_dispatch_url,
    updated_at = now();
end
$$;
