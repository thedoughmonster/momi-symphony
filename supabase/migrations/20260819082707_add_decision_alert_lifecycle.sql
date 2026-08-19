-- service-owner: agent-control

create table momi_agent_ops.decision_alert_policies (
  route_key text primary key check (length(route_key) between 1 and 200),
  linear_project_id uuid not null unique
    references momi_agent_ops.project_mappings(linear_project_id),
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  base_branch text not null check (base_branch ~ '^[A-Za-z0-9._/-]+$'),
  destination_key text check (
    destination_key is null or destination_key ~ '^[a-z][a-z0-9_]{2,79}$'
  ),
  slack_channel_id text check (
    slack_channel_id is null or slack_channel_id ~ '^C[A-Z0-9]{8,20}$'
  ),
  mode text not null default 'disabled' check (mode in ('disabled', 'acceptance', 'enabled')),
  acceptance_issue_ids uuid[] not null default '{}'::uuid[],
  accepted_release_sha text check (
    accepted_release_sha is null or accepted_release_sha ~ '^[0-9a-f]{40}$'
  ),
  acceptance_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((destination_key is null) = (slack_channel_id is null)),
  check (
    mode = 'disabled'
    or (mode = 'acceptance' and destination_key is not null
      and cardinality(acceptance_issue_ids) between 1 and 20
      and accepted_release_sha is not null and acceptance_completed_at is not null)
    or (mode = 'enabled' and destination_key is not null
      and cardinality(acceptance_issue_ids) = 0
      and accepted_release_sha is not null and acceptance_completed_at is not null)
  )
);

insert into momi_agent_ops.decision_alert_policies (
  route_key, linear_project_id, repository, base_branch
)
select
  'symphony-control-plane', mapping.linear_project_id,
  mapping.repository, mapping.base_branch
from momi_agent_ops.project_mappings mapping
where mapping.active
  and mapping.repository = 'thedoughmonster/momi-symphony'
  and mapping.base_branch = 'main'
on conflict (route_key) do nothing;

create table momi_agent_ops.decision_alerts (
  alert_id uuid primary key default gen_random_uuid(),
  linear_project_id uuid not null
    references momi_agent_ops.decision_alert_policies(linear_project_id),
  linear_issue_id uuid not null,
  source_comment_id uuid not null,
  decision_key text not null check (decision_key ~ '^[a-z0-9][a-z0-9._:-]{2,79}$'),
  decision_identity text not null unique check (length(decision_identity) between 20 and 300),
  category text not null check (category in (
    'material_architecture_ownership', 'public_contract', 'security_privacy',
    'meaningful_cost_external_exposure', 'destructive_migration',
    'production_infrastructure_authority', 'ambiguous_product_behavior',
    'repository_law_conflict'
  )),
  decision_status text not null check (decision_status in ('unresolved', 'resolved')),
  issue_identifier text not null check (
    issue_identifier ~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$'
  ),
  issue_title text not null check (length(issue_title) between 1 and 300),
  issue_url text not null check (issue_url ~ '^https://linear\.app/'),
  question text not null check (length(question) between 10 and 500),
  policy_gap text not null check (length(policy_gap) between 10 and 500),
  recommendation text not null check (length(recommendation) between 3 and 500),
  alternatives text[] not null check (cardinality(alternatives) between 1 and 5),
  consequences text[] not null check (cardinality(consequences) between 1 and 5),
  affected_issue_identifiers text[] not null check (
    cardinality(affected_issue_identifiers) between 1 and 20
  ),
  resolution_summary text check (
    resolution_summary is null or length(resolution_summary) between 3 and 500
  ),
  lifecycle_state text not null check (lifecycle_state in (
    'pending', 'retry_wait', 'delivered', 'ambiguous', 'failed',
    'resolution_pending', 'resolution_retry_wait', 'resolution_ambiguous',
    'resolution_failed', 'resolved', 'resolved_without_receipt'
  )),
  slack_channel_id text check (
    slack_channel_id is null or slack_channel_id ~ '^C[A-Z0-9]{8,20}$'
  ),
  slack_message_ts text check (
    slack_message_ts is null or slack_message_ts ~ '^[0-9]{10,}\.[0-9]+$'
  ),
  first_alerted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (linear_issue_id, source_comment_id, decision_key),
  check ((slack_channel_id is null) = (slack_message_ts is null)),
  check (
    (decision_status = 'unresolved' and resolution_summary is null)
    or (decision_status = 'resolved' and resolution_summary is not null)
  )
);

create table momi_agent_ops.decision_delivery_work (
  work_id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references momi_agent_ops.decision_alerts(alert_id),
  delivery_kind text not null check (delivery_kind in ('initial', 'resolution')),
  capability_token_hash text not null check (capability_token_hash ~ '^[0-9a-f]{64}$'),
  work_status text not null check (
    work_status in ('pending', 'claimed', 'delivered', 'retryable', 'ambiguous', 'failed')
  ),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alert_id, delivery_kind),
  check (
    (work_status = 'claimed' and lease_expires_at is not null and completed_at is null)
    or (work_status in ('pending', 'retryable') and lease_expires_at is null and completed_at is null)
    or (work_status in ('delivered', 'ambiguous', 'failed')
      and lease_expires_at is null and completed_at is not null)
  )
);

create table momi_agent_ops.decision_delivery_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  work_id uuid not null references momi_agent_ops.decision_delivery_work(work_id),
  attempt_number integer not null check (attempt_number between 1 and 20),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome text not null check (
    outcome in ('started', 'delivered', 'retryable', 'ambiguous', 'failed')
  ),
  http_status integer check (http_status is null or http_status between 100 and 599),
  retry_after_seconds integer check (
    retry_after_seconds is null or retry_after_seconds between 1 and 900
  ),
  slack_channel_id text check (
    slack_channel_id is null or slack_channel_id ~ '^C[A-Z0-9]{8,20}$'
  ),
  slack_message_ts text check (
    slack_message_ts is null or slack_message_ts ~ '^[0-9]{10,}\.[0-9]+$'
  ),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,120}$'),
  unique (work_id, attempt_number),
  check (
    (outcome = 'started' and completed_at is null)
    or (outcome <> 'started' and completed_at is not null)
  ),
  check ((slack_channel_id is null) = (slack_message_ts is null))
);

create index decision_alerts_issue_lifecycle_idx
  on momi_agent_ops.decision_alerts (linear_issue_id, lifecycle_state);
create index decision_delivery_work_due_idx
  on momi_agent_ops.decision_delivery_work (work_status, next_attempt_at);

alter table momi_agent_ops.decision_alert_policies enable row level security;
alter table momi_agent_ops.decision_alerts enable row level security;
alter table momi_agent_ops.decision_delivery_work enable row level security;
alter table momi_agent_ops.decision_delivery_attempts enable row level security;
revoke all on table momi_agent_ops.decision_alert_policies,
  momi_agent_ops.decision_alerts,
  momi_agent_ops.decision_delivery_work,
  momi_agent_ops.decision_delivery_attempts
  from public, anon, authenticated, service_role;

create function momi_agent_ops.reconcile_decision_alert_v1(
  p_linear_project_id uuid,
  p_linear_issue_id uuid,
  p_issue_identifier text,
  p_issue_title text,
  p_issue_url text,
  p_source_comment_id uuid,
  p_decision_key text,
  p_decision_identity text,
  p_category text,
  p_decision_status text,
  p_question text,
  p_policy_gap text,
  p_recommendation text,
  p_alternatives text[],
  p_consequences text[],
  p_affected_issue_identifiers text[],
  p_resolution_summary text
) returns table (
  disposition text,
  work_id uuid,
  capability_token uuid
) language plpgsql security invoker set search_path = '' as $$
declare
  policy momi_agent_ops.decision_alert_policies%rowtype;
  current_alert momi_agent_ops.decision_alerts%rowtype;
  current_work momi_agent_ops.decision_delivery_work%rowtype;
  selected_kind text;
  next_token uuid;
  next_work_id uuid;
  expected_identity text;
  route_enabled boolean;
begin
  select configured.* into policy
  from momi_agent_ops.decision_alert_policies configured
  where configured.linear_project_id = p_linear_project_id
  for update;
  expected_identity := 'linear:' || p_linear_issue_id::text || ':'
    || p_source_comment_id::text || ':' || p_decision_key;
  if policy.route_key is null or p_linear_issue_id is null or p_source_comment_id is null
    or p_issue_identifier is null or p_issue_title is null or p_issue_url is null
    or p_decision_key is null or p_decision_identity is null or p_category is null
    or p_decision_status is null or p_question is null or p_policy_gap is null
    or p_recommendation is null or p_alternatives is null or p_consequences is null
    or p_affected_issue_identifiers is null
    or p_issue_identifier !~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$'
    or length(p_issue_title) not between 1 and 300
    or p_issue_url !~ '^https://linear\.app/'
    or p_decision_key !~ '^[a-z0-9][a-z0-9._:-]{2,79}$'
    or p_decision_identity is distinct from expected_identity
    or p_category not in (
      'material_architecture_ownership', 'public_contract', 'security_privacy',
      'meaningful_cost_external_exposure', 'destructive_migration',
      'production_infrastructure_authority', 'ambiguous_product_behavior',
      'repository_law_conflict'
    )
    or p_decision_status not in ('unresolved', 'resolved')
    or length(p_question) not between 10 and 500
    or length(p_policy_gap) not between 10 and 500
    or length(p_recommendation) not between 3 and 500
    or cardinality(p_alternatives) not between 1 and 5
    or cardinality(p_consequences) not between 1 and 5
    or cardinality(p_affected_issue_identifiers) not between 1 and 20
    or exists (select 1 from unnest(p_alternatives) item
      where item is null or length(item) not between 1 and 300 or item ~ '[\n\r]')
    or exists (select 1 from unnest(p_consequences) item
      where item is null or length(item) not between 1 and 300 or item ~ '[\n\r]')
    or exists (select 1 from unnest(p_affected_issue_identifiers) item
      where item is null or item !~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$')
    or (select count(*) from unnest(p_alternatives) item)
      <> (select count(distinct item) from unnest(p_alternatives) item)
    or (select count(*) from unnest(p_consequences) item)
      <> (select count(distinct item) from unnest(p_consequences) item)
    or (select count(*) from unnest(p_affected_issue_identifiers) item)
      <> (select count(distinct item) from unnest(p_affected_issue_identifiers) item)
    or not (p_issue_identifier = any (p_affected_issue_identifiers))
    or (p_decision_status = 'unresolved' and p_resolution_summary is not null)
    or (p_decision_status = 'resolved'
      and coalesce(length(p_resolution_summary), 0) not between 3 and 500)
    or concat_ws(' ', p_issue_title, p_question, p_policy_gap, p_recommendation,
      array_to_string(p_alternatives, ' '), array_to_string(p_consequences, ' '),
      coalesce(p_resolution_summary, '')) ~* '<!(channel|here|everyone|subteam)|<@[A-Z0-9]+>'
  then
    raise exception 'decision_reconciliation_input_invalid' using errcode = '22023';
  end if;

  select alert.* into current_alert
  from momi_agent_ops.decision_alerts alert
  where alert.decision_identity = p_decision_identity
  for update;
  if not found then
    insert into momi_agent_ops.decision_alerts (
      linear_project_id, linear_issue_id, source_comment_id, decision_key,
      decision_identity, category, decision_status, issue_identifier, issue_title,
      issue_url, question, policy_gap, recommendation, alternatives, consequences,
      affected_issue_identifiers, resolution_summary, lifecycle_state, resolved_at
    ) values (
      p_linear_project_id, p_linear_issue_id, p_source_comment_id, p_decision_key,
      p_decision_identity, p_category, p_decision_status, p_issue_identifier,
      p_issue_title, p_issue_url, p_question, p_policy_gap, p_recommendation,
      p_alternatives, p_consequences, p_affected_issue_identifiers,
      p_resolution_summary,
      case when p_decision_status = 'unresolved' then 'pending'
        else 'resolved_without_receipt' end,
      case when p_decision_status = 'resolved' then now() else null end
    ) returning * into current_alert;
  else
    if current_alert.linear_issue_id <> p_linear_issue_id
      or current_alert.source_comment_id <> p_source_comment_id
      or current_alert.decision_key <> p_decision_key then
      raise exception 'decision_identity_conflict' using errcode = '23505';
    end if;
    update momi_agent_ops.decision_alerts alert set
      category = p_category,
      decision_status = p_decision_status,
      issue_identifier = p_issue_identifier,
      issue_title = p_issue_title,
      issue_url = p_issue_url,
      question = p_question,
      policy_gap = p_policy_gap,
      recommendation = p_recommendation,
      alternatives = p_alternatives,
      consequences = p_consequences,
      affected_issue_identifiers = p_affected_issue_identifiers,
      resolution_summary = p_resolution_summary,
      lifecycle_state = case
        when p_decision_status = 'resolved' and alert.slack_message_ts is null
          then 'resolved_without_receipt'
        when p_decision_status = 'resolved' and alert.lifecycle_state = 'delivered'
          then 'resolution_pending'
        else alert.lifecycle_state end,
      resolved_at = case when p_decision_status = 'resolved'
        then coalesce(alert.resolved_at, now()) else null end,
      updated_at = now()
    where alert.alert_id = current_alert.alert_id
    returning * into current_alert;
  end if;

  route_enabled := policy.mode = 'enabled'
    or (policy.mode = 'acceptance'
      and p_linear_issue_id = any (policy.acceptance_issue_ids));
  if not route_enabled then
    return query select 'disabled'::text, null::uuid, null::uuid;
    return;
  end if;

  if p_decision_status = 'unresolved' then
    if current_alert.lifecycle_state in ('delivered', 'ambiguous', 'failed',
      'resolution_pending', 'resolution_retry_wait', 'resolution_ambiguous',
      'resolution_failed', 'resolved', 'resolved_without_receipt') then
      return query select 'duplicate'::text, null::uuid, null::uuid;
      return;
    end if;
    selected_kind := 'initial';
  else
    if current_alert.slack_message_ts is null then
      return query select 'resolved_without_receipt'::text, null::uuid, null::uuid;
      return;
    end if;
    if current_alert.lifecycle_state = 'resolved' then
      return query select 'duplicate_resolution'::text, null::uuid, null::uuid;
      return;
    end if;
    selected_kind := 'resolution';
  end if;

  select work.* into current_work
  from momi_agent_ops.decision_delivery_work work
  where work.alert_id = current_alert.alert_id
    and work.delivery_kind = selected_kind
  for update;
  if found and current_work.work_status in ('claimed', 'delivered', 'ambiguous', 'failed') then
    return query select ('work_' || current_work.work_status)::text,
      null::uuid, null::uuid;
    return;
  end if;
  if found and current_work.work_status = 'retryable'
    and current_work.next_attempt_at > now() then
    return query select 'retry_wait'::text, null::uuid, null::uuid;
    return;
  end if;

  next_token := gen_random_uuid();
  if not found then
    insert into momi_agent_ops.decision_delivery_work (
      alert_id, delivery_kind, capability_token_hash, work_status
    ) values (
      current_alert.alert_id, selected_kind,
      encode(extensions.digest(convert_to(next_token::text, 'UTF8'), 'sha256'), 'hex'),
      'pending'
    ) returning momi_agent_ops.decision_delivery_work.work_id into next_work_id;
  else
    update momi_agent_ops.decision_delivery_work work set
      capability_token_hash = encode(extensions.digest(
        convert_to(next_token::text, 'UTF8'), 'sha256'), 'hex'),
      work_status = 'pending', next_attempt_at = now(), lease_expires_at = null,
      completed_at = null, updated_at = now()
    where work.work_id = current_work.work_id
    returning work.work_id into next_work_id;
  end if;
  update momi_agent_ops.decision_alerts alert set
    lifecycle_state = case when selected_kind = 'initial' then 'pending'
      else 'resolution_pending' end,
    updated_at = now()
  where alert.alert_id = current_alert.alert_id;
  return query select ('delivery_ready_' || selected_kind)::text,
    next_work_id, next_token;
end;
$$;

create function momi_agent_ops.claim_decision_delivery_v1(
  p_work_id uuid,
  p_capability_token uuid
) returns table (
  attempt_id uuid,
  work_id uuid,
  delivery_kind text,
  decision_identity text,
  issue_identifier text,
  issue_title text,
  issue_url text,
  category text,
  question text,
  policy_gap text,
  recommendation text,
  alternatives text[],
  consequences text[],
  affected_issue_identifiers text[],
  resolution_summary text,
  slack_channel_id text,
  slack_thread_ts text
) language plpgsql security invoker set search_path = '' as $$
declare
  work momi_agent_ops.decision_delivery_work%rowtype;
  alert momi_agent_ops.decision_alerts%rowtype;
  policy momi_agent_ops.decision_alert_policies%rowtype;
  next_attempt_id uuid;
begin
  select queued.* into work
  from momi_agent_ops.decision_delivery_work queued
  where queued.work_id = p_work_id
  for update;
  if not found or p_capability_token is null
    or work.capability_token_hash <> encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex') then
    return;
  end if;
  select current_alert.* into alert
  from momi_agent_ops.decision_alerts current_alert
  where current_alert.alert_id = work.alert_id
  for update;
  select configured.* into policy
  from momi_agent_ops.decision_alert_policies configured
  where configured.linear_project_id = alert.linear_project_id;
  if policy.route_key is null or policy.slack_channel_id is null
    or not (policy.mode = 'enabled' or (policy.mode = 'acceptance'
      and alert.linear_issue_id = any (policy.acceptance_issue_ids))) then
    return;
  end if;
  if work.work_status = 'claimed' and work.lease_expires_at <= now()
    and exists (select 1 from momi_agent_ops.decision_delivery_attempts attempt
      where attempt.work_id = work.work_id and attempt.outcome = 'started') then
    update momi_agent_ops.decision_delivery_work queued set
      work_status = 'ambiguous', lease_expires_at = null, completed_at = now(),
      updated_at = now()
    where queued.work_id = work.work_id;
    update momi_agent_ops.decision_alerts current_alert set
      lifecycle_state = case when work.delivery_kind = 'initial'
        then 'ambiguous' else 'resolution_ambiguous' end,
      updated_at = now()
    where current_alert.alert_id = alert.alert_id;
    return;
  end if;
  if work.work_status not in ('pending', 'retryable')
    or work.next_attempt_at > now() or work.attempt_count >= 20 then
    return;
  end if;
  if work.delivery_kind = 'initial' and alert.decision_status <> 'unresolved' then return; end if;
  if work.delivery_kind = 'resolution' and (
    alert.decision_status <> 'resolved' or alert.slack_message_ts is null
  ) then return; end if;

  next_attempt_id := gen_random_uuid();
  update momi_agent_ops.decision_delivery_work queued set
    work_status = 'claimed', attempt_count = queued.attempt_count + 1,
    lease_expires_at = now() + interval '90 seconds', updated_at = now()
  where queued.work_id = work.work_id;
  insert into momi_agent_ops.decision_delivery_attempts (
    attempt_id, work_id, attempt_number, outcome
  ) values (next_attempt_id, work.work_id, work.attempt_count + 1, 'started');

  return query select next_attempt_id, work.work_id, work.delivery_kind,
    alert.decision_identity, alert.issue_identifier, alert.issue_title,
    alert.issue_url, alert.category, alert.question, alert.policy_gap,
    alert.recommendation, alert.alternatives, alert.consequences,
    alert.affected_issue_identifiers, alert.resolution_summary,
    policy.slack_channel_id, alert.slack_message_ts;
end;
$$;

create function momi_agent_ops.finalize_decision_delivery_v1(
  p_work_id uuid,
  p_capability_token uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_http_status integer,
  p_retry_after_seconds integer,
  p_slack_channel_id text,
  p_slack_message_ts text,
  p_error_code text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  work momi_agent_ops.decision_delivery_work%rowtype;
  alert momi_agent_ops.decision_alerts%rowtype;
  policy momi_agent_ops.decision_alert_policies%rowtype;
begin
  select queued.* into work
  from momi_agent_ops.decision_delivery_work queued
  where queued.work_id = p_work_id
  for update;
  if not found or p_capability_token is null or work.work_status <> 'claimed'
    or work.capability_token_hash <> encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    or p_outcome not in ('delivered', 'retryable', 'ambiguous', 'failed')
    or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,120}$') then
    return false;
  end if;
  select current_alert.* into alert
  from momi_agent_ops.decision_alerts current_alert
  where current_alert.alert_id = work.alert_id
  for update;
  select configured.* into policy
  from momi_agent_ops.decision_alert_policies configured
  where configured.linear_project_id = alert.linear_project_id;
  if not exists (
    select 1 from momi_agent_ops.decision_delivery_attempts attempt
    where attempt.attempt_id = p_attempt_id and attempt.work_id = work.work_id
      and attempt.outcome = 'started'
  ) then return false; end if;
  if p_outcome = 'delivered' and (
    p_http_status is null or p_http_status not between 200 and 299
    or p_slack_channel_id is distinct from policy.slack_channel_id
    or coalesce(p_slack_message_ts ~ '^[0-9]{10,}\.[0-9]+$', false) = false
    or p_error_code is not null or p_retry_after_seconds is not null
  ) then return false; end if;
  if p_outcome = 'retryable' and (
    p_http_status is distinct from 429 or p_retry_after_seconds is null
    or p_retry_after_seconds not between 1 and 900
    or p_slack_channel_id is not null or p_slack_message_ts is not null
  ) then return false; end if;
  if p_outcome in ('ambiguous', 'failed') and (
    p_slack_channel_id is not null or p_slack_message_ts is not null
    or p_retry_after_seconds is not null or p_error_code is null
  ) then return false; end if;

  update momi_agent_ops.decision_delivery_attempts attempt set
    completed_at = now(), outcome = p_outcome, http_status = p_http_status,
    retry_after_seconds = p_retry_after_seconds,
    slack_channel_id = p_slack_channel_id, slack_message_ts = p_slack_message_ts,
    error_code = p_error_code
  where attempt.attempt_id = p_attempt_id;

  update momi_agent_ops.decision_delivery_work queued set
    work_status = case when p_outcome = 'retryable' then 'retryable'
      else p_outcome end,
    next_attempt_at = case when p_outcome = 'retryable'
      then now() + make_interval(secs => p_retry_after_seconds) else queued.next_attempt_at end,
    lease_expires_at = null,
    completed_at = case when p_outcome = 'retryable' then null else now() end,
    updated_at = now()
  where queued.work_id = work.work_id;

  update momi_agent_ops.decision_alerts current_alert set
    lifecycle_state = case
      when work.delivery_kind = 'initial' and p_outcome = 'delivered' then 'delivered'
      when work.delivery_kind = 'initial' and p_outcome = 'retryable' then 'retry_wait'
      when work.delivery_kind = 'initial' and p_outcome = 'ambiguous' then 'ambiguous'
      when work.delivery_kind = 'initial' and p_outcome = 'failed' then 'failed'
      when work.delivery_kind = 'resolution' and p_outcome = 'delivered' then 'resolved'
      when work.delivery_kind = 'resolution' and p_outcome = 'retryable'
        then 'resolution_retry_wait'
      when work.delivery_kind = 'resolution' and p_outcome = 'ambiguous'
        then 'resolution_ambiguous'
      else 'resolution_failed' end,
    slack_channel_id = case when work.delivery_kind = 'initial'
      and p_outcome = 'delivered' then p_slack_channel_id
      else current_alert.slack_channel_id end,
    slack_message_ts = case when work.delivery_kind = 'initial'
      and p_outcome = 'delivered' then p_slack_message_ts
      else current_alert.slack_message_ts end,
    first_alerted_at = case when work.delivery_kind = 'initial'
      and p_outcome = 'delivered' then coalesce(current_alert.first_alerted_at, now())
      else current_alert.first_alerted_at end,
    updated_at = now()
  where current_alert.alert_id = alert.alert_id;
  return true;
end;
$$;

create function momi_agent_ops.decision_alert_preflight_v1()
returns table (
  route_mode text,
  destination_configured boolean,
  release_configured boolean
) language sql security invoker set search_path = '' as $$
  select policy.mode,
    policy.destination_key is not null and policy.slack_channel_id is not null,
    policy.accepted_release_sha is not null
  from momi_agent_ops.decision_alert_policies policy
  where policy.route_key = 'symphony-control-plane'
$$;

create function momi_agent_ops.configure_decision_alert_acceptance_v1(
  p_destination_key text,
  p_slack_channel_id text,
  p_linear_issue_id uuid,
  p_release_sha text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_destination_key !~ '^[a-z][a-z0-9_]{2,79}$'
    or p_slack_channel_id !~ '^C[A-Z0-9]{8,20}$'
    or p_linear_issue_id is null or p_release_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'decision_acceptance_configuration_invalid' using errcode = '22023';
  end if;
  update momi_agent_ops.decision_alert_policies policy set
    destination_key = p_destination_key,
    slack_channel_id = p_slack_channel_id,
    mode = 'acceptance',
    acceptance_issue_ids = array[p_linear_issue_id],
    accepted_release_sha = p_release_sha,
    acceptance_completed_at = now(),
    updated_at = now()
  where policy.route_key = 'symphony-control-plane';
  return found;
end;
$$;

create function momi_agent_ops.disable_decision_alert_delivery_v1()
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update momi_agent_ops.decision_alert_policies policy set
    mode = 'disabled', acceptance_issue_ids = '{}'::uuid[], updated_at = now()
  where policy.route_key = 'symphony-control-plane';
  return found;
end;
$$;

revoke all on function momi_agent_ops.reconcile_decision_alert_v1(
  uuid, uuid, text, text, text, uuid, text, text, text, text, text, text,
  text, text[], text[], text[], text
),
  momi_agent_ops.claim_decision_delivery_v1(uuid, uuid),
  momi_agent_ops.finalize_decision_delivery_v1(
    uuid, uuid, uuid, text, integer, integer, text, text, text
  ),
  momi_agent_ops.decision_alert_preflight_v1(),
  momi_agent_ops.configure_decision_alert_acceptance_v1(text, text, uuid, text),
  momi_agent_ops.disable_decision_alert_delivery_v1()
  from public, anon, authenticated, service_role;
