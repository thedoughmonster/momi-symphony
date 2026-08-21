-- service-owner: agent-control

create function momi_agent_ops.scheduler_route_has_implementation_capacity_v1(
  p_route_key text,
  p_owner_id uuid,
  p_release_sha text,
  p_leader_generation bigint
) returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select
      count(*) filter (
        where slot.state in ('reserved', 'running', 'quarantined')
      ) < policy.max_concurrent
      and count(*) filter (
        where slot.action_class = 'implementation'
          and slot.state in ('reserved', 'running', 'quarantined')
      ) < policy.implementation_limit
    from momi_agent_ops.scheduler_route_policies policy
    join momi_agent_ops.scheduler_leaders leader
      on leader.route_key = policy.route_key
      and leader.owner_id = p_owner_id
      and leader.fencing_generation = p_leader_generation
      and leader.lease_expires_at > now()
    left join momi_agent_ops.scheduler_slots slot
      on slot.route_key = policy.route_key
    where policy.route_key = p_route_key
      and policy.mode = 'enabled'
      and policy.accepted_release_sha = p_release_sha
      and policy.acceptance_completed_at is not null
    group by policy.max_concurrent, policy.implementation_limit
  ), false)
$$;

revoke all on function
  momi_agent_ops.scheduler_route_has_implementation_capacity_v1(
    text, uuid, text, bigint
  ) from public, anon, authenticated, service_role;
