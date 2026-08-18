update momi_agent_ops.project_mappings
set active = false,
  updated_at = now()
where linear_project_id = 'de0dbcdb-9025-4ccc-8b3c-56f23d7367d5'
  and repository = 'thedoughmonster/momi-symphony'
  and base_branch = 'main';
