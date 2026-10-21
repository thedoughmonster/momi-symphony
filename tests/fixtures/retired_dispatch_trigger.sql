-- Synthetic local fixture: no operator SQL, credentials, or deployment identities.
create schema momi_agent_ops;

create table momi_agent_ops.project_mappings (
  linear_project_id uuid primary key,
  repository text not null,
  host_dispatch_url text not null,
  active boolean not null
);
insert into momi_agent_ops.project_mappings values (
  '11111111-1111-4111-8111-111111111111', 'fixture/example',
  'https://example.invalid/v1/dispatch', false
);
create table momi_agent_ops.scheduler_route_policies (mode text not null);
insert into momi_agent_ops.scheduler_route_policies values ('disabled');
create table momi_agent_ops.decision_alert_policies (mode text not null);
insert into momi_agent_ops.decision_alert_policies values ('disabled');
create table momi_agent_ops.scheduler_leaders (lease_expires_at timestamptz);
create table momi_agent_ops.scheduler_slots (state text not null);
create table momi_agent_ops.review_attempts (state text not null);
create table momi_agent_ops.decision_delivery_work (work_status text not null);

create table momi_agent_ops.dispatches (
  dispatch_id uuid primary key,
  work_status text not null,
  host_accepted_at timestamptz,
  historical_evidence jsonb not null
);
create table momi_agent_ops.run_records (
  dispatch_id uuid primary key references momi_agent_ops.dispatches,
  terminal_at timestamptz,
  terminal_disposition text
);
insert into momi_agent_ops.dispatches values (
  '22222222-2222-4222-8222-222222222222', 'completed',
  '2000-01-01T00:00:00Z', '{"synthetic_history":"preserve"}'
);
insert into momi_agent_ops.run_records values (
  '22222222-2222-4222-8222-222222222222',
  '2000-01-01T00:01:00Z', 'completed'
);

create function momi_agent_ops.wake_agent_control_dispatch() returns trigger
  language plpgsql as 'begin return new; end';
create function momi_agent_ops.bookkeeping_sentinel() returns trigger
  language plpgsql as 'begin return new; end';
create trigger dispatch_agent_control_work after insert on momi_agent_ops.dispatches
  for each row execute function momi_agent_ops.wake_agent_control_dispatch();
create trigger bookkeeping_sentinel after insert on momi_agent_ops.dispatches
  for each row execute function momi_agent_ops.bookkeeping_sentinel();
