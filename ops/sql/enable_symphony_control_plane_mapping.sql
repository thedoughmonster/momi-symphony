do $$
declare
  updated_count integer;
begin
  update momi_agent_ops.project_mappings
  set active = true,
    updated_at = now()
  where linear_project_id = 'de0dbcdb-9025-4ccc-8b3c-56f23d7367d5'
    and linear_project_name = 'Symphony Control Plane'
    and repository = 'thedoughmonster/momi-symphony'
    and base_branch = 'main'
    and host_dispatch_url ~ '^https://';

  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'symphony_mapping_enable_count:%', updated_count;
  end if;
end
$$;
