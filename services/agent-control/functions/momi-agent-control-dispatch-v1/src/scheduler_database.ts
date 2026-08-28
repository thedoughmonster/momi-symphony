import { getDatabase } from "../../../src/database.ts"
import type { NormalizedLinearIssue } from "./linear_issue_adapter.ts"

export type SchedulerRoute = {
  routeKey: string
  projectId: string
  teamId: string | null
  repository: string
  baseBranch: string
  hostDispatchUrl: string
  activeStates: string[]
  requiredLabels: string[]
  mode: "observe" | "enabled"
  acceptanceIssueIds: string[]
}

export type SchedulerLeader = {
  routeKey: string
  generation: number
}

export type SchedulerCandidate = {
  candidateId: string
  generation: number
  generationState: "waiting" | "eligible" | "claimed" | "running" | "terminal" | "stale"
  snapshotVersion: number
  schedulerEligible: boolean
}

export type SchedulerClaim = { dispatchId: string }
export type SchedulerHeartbeatMetrics = {
  quarantinesCreated: number
  quarantineCapacityReleased: number
  activeQuarantines: number
  oldestQuarantineAgeSeconds: number
  manualInterventions: number
}

export async function listSchedulerRoutes(): Promise<SchedulerRoute[]> {
  const sql = getDatabase()
  const rows = await sql<{
    route_key: string
    linear_project_id: string
    repository: string
    base_branch: string
    host_dispatch_url: string
    active_states: string[]
    required_labels: string[]
    mode: "observe" | "enabled"
    acceptance_issue_ids: string[]
  }[]>`
    select policy.route_key, mapping.linear_project_id::text,
      policy.repository, policy.base_branch, policy.host_dispatch_url,
      mapping.active_states, policy.required_labels, policy.mode,
      policy.acceptance_issue_ids::text[]
    from momi_agent_ops.scheduler_route_policies policy
    join momi_agent_ops.project_mappings mapping
      on mapping.repository = policy.repository
      and mapping.base_branch = policy.base_branch
      and mapping.host_dispatch_url = policy.host_dispatch_url
      and mapping.active
    where policy.mode in ('observe', 'enabled')
      and policy.next_provider_attempt_at <= now()
    order by policy.route_key, mapping.linear_project_id
  `
  return rows.map((row) => ({
    routeKey: row.route_key,
    projectId: row.linear_project_id,
    teamId: null,
    repository: row.repository,
    baseBranch: row.base_branch,
    hostDispatchUrl: row.host_dispatch_url,
    activeStates: row.active_states,
    requiredLabels: row.required_labels,
    mode: row.mode,
    acceptanceIssueIds: row.acceptance_issue_ids,
  }))
}

export async function acquireSchedulerLeader(
  routeKey: string,
  ownerId: string,
  releaseSha: string,
): Promise<SchedulerLeader | null> {
  const sql = getDatabase()
  const rows = await sql<{ route_key: string; fencing_generation: number }[]>`
    select route_key, fencing_generation::integer
    from momi_agent_ops.acquire_scheduler_leader_v1(
      ${routeKey}, ${ownerId}::uuid, ${releaseSha}
    )
  `
  return rows[0]
    ? { routeKey: rows[0].route_key, generation: rows[0].fencing_generation }
    : null
}

export async function listSchedulerCandidateIds(route: SchedulerRoute): Promise<string[]> {
  const sql = getDatabase()
  const rows = await sql<{ linear_issue_id: string }[]>`
    select linear_issue_id::text
    from momi_agent_ops.scheduler_candidates
    where route_key = ${route.routeKey}
      and linear_project_id = ${route.projectId}::uuid
      and generation_state in ('waiting', 'eligible', 'claimed', 'running', 'stale')
    order by linear_issue_id
    limit 250
  `
  return rows.map((row) => row.linear_issue_id)
}

export async function listProjectableAgentStateDispatchIds(
  route: SchedulerRoute,
): Promise<string[]> {
  const sql = getDatabase()
  const rows = await sql<{ dispatch_id: string }[]>`
    select current_work.dispatch_id::text
    from momi_agent_ops.dispatches current_work
    join momi_agent_ops.run_records run on run.dispatch_id = current_work.dispatch_id
    join momi_agent_ops.project_mappings mapping
      on mapping.linear_project_id = current_work.linear_project_id
      and mapping.active
      and mapping.repository = ${route.repository}
      and mapping.base_branch = ${route.baseBranch}
      and mapping.host_dispatch_url = ${route.hostDispatchUrl}
    where current_work.action not in ('cancel-run', 'recover-discovery')
      and not exists (
        select 1 from momi_agent_ops.dispatches newer
        where newer.linear_issue_id = current_work.linear_issue_id
          and newer.action not in ('cancel-run', 'recover-discovery')
          and (newer.created_at, newer.dispatch_id) >
            (current_work.created_at, current_work.dispatch_id)
      )
    order by current_work.created_at desc, current_work.dispatch_id desc
    limit 250
  `
  return rows.map((row) => row.dispatch_id)
}

export async function reconcileSchedulerCandidate(
  route: SchedulerRoute,
  issue: NormalizedLinearIssue,
): Promise<SchedulerCandidate> {
  const sql = getDatabase()
  const rows = await sql<{
    candidate_id: string
    generation: number
    generation_state: SchedulerCandidate["generationState"]
    snapshot_version: number
    scheduler_eligible: boolean
  }[]>`
    select candidate_id::text, generation::integer, generation_state,
      snapshot_version::integer, scheduler_eligible
    from momi_agent_ops.reconcile_scheduler_candidate_v1(
      ${route.routeKey}, ${route.projectId}::uuid, ${issue.id}::uuid,
      ${issue.identifier}, ${issue.url}, ${issue.state}, ${issue.priority},
      ${issue.created_at}::timestamptz, ${issue.updated_at}::timestamptz,
      ${issue.labels}::text[], ${issue.dispatchable},
      ${issue.dispatchability_reasons}::text[]
    )
  `
  const row = rows[0]
  if (!row) throw new Error("scheduler_candidate_reconcile_failed")
  return {
    candidateId: row.candidate_id,
    generation: row.generation,
    generationState: row.generation_state,
    snapshotVersion: row.snapshot_version,
    schedulerEligible: row.scheduler_eligible,
  }
}

export async function markSchedulerCandidateStale(
  route: SchedulerRoute,
  issueId: string,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ stale: boolean }[]>`
    select momi_agent_ops.mark_scheduler_candidate_stale_v1(
      ${route.routeKey}, ${route.projectId}::uuid, ${issueId}::uuid
    ) as stale
  `
  return rows[0]?.stale === true
}

export async function claimSchedulerCandidate(
  route: SchedulerRoute,
  ownerId: string,
  releaseSha: string,
  leader: SchedulerLeader,
  candidate: SchedulerCandidate,
): Promise<SchedulerClaim | null> {
  const sql = getDatabase()
  const rows = await sql<{ claimed: boolean; dispatch_id: string | null }[]>`
    select claimed, dispatch_id::text
    from momi_agent_ops.claim_scheduler_candidate_v3(
      ${route.routeKey}, ${ownerId}::uuid, ${releaseSha}, ${leader.generation},
      ${candidate.candidateId}::uuid, ${candidate.generation},
      ${candidate.snapshotVersion}
    )
  `
  return rows[0]?.claimed === true && rows[0].dispatch_id
    ? { dispatchId: rows[0].dispatch_id } : null
}

export async function heartbeatSchedulerSlots(
  activeWorkIds: readonly string[],
): Promise<SchedulerHeartbeatMetrics> {
  const sql = getDatabase()
  const rows = await sql<{ quarantined: number; capacity_released: number;
    active_quarantines: number; oldest_quarantine_age_seconds: number;
    manual_interventions: number }[]>`
    select quarantined::integer, capacity_released::integer,
      active_quarantines::integer, oldest_quarantine_age_seconds::integer,
      manual_interventions::integer
    from momi_agent_ops.heartbeat_scheduler_slots_v2(
      ${activeWorkIds}::uuid[]
    )
  `
  const row = rows[0]
  if (!row) throw new Error("scheduler_heartbeat_failed")
  return { quarantinesCreated: row.quarantined,
    quarantineCapacityReleased: row.capacity_released,
    activeQuarantines: row.active_quarantines,
    oldestQuarantineAgeSeconds: row.oldest_quarantine_age_seconds,
    manualInterventions: row.manual_interventions }
}

export async function recordSchedulerProviderRetry(
  routeKey: string,
  errorCode: string,
): Promise<void> {
  const sql = getDatabase()
  await sql`
    select momi_agent_ops.record_scheduler_provider_retry_v1(
      ${routeKey}, ${errorCode}
    )
  `
}

export async function recordSchedulerProviderSuccess(routeKey: string): Promise<void> {
  const sql = getDatabase()
  await sql`
    select momi_agent_ops.record_scheduler_provider_success_v1(${routeKey})
  `
}
