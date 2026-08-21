import type { Sql } from "postgres"

export const projectId = "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5"
export const releaseSha = "b".repeat(40)
export const wrongReleaseSha = "c".repeat(40)
export const ownerOne = "10000000-0000-4000-8000-000000000001"
export const ownerTwo = "10000000-0000-4000-8000-000000000002"
export const ownerThree = "10000000-0000-4000-8000-000000000003"
export const routeKey = "thedoughmonster/momi-symphony@main|https://host.example/v1/dispatch"

export type Candidate = {
  candidate_id: string
  generation: number
  generation_state: string
  snapshot_version: number
  scheduler_eligible: boolean
}

export type Claim = { claimed: boolean; dispatch_id: string | null }

export function issueId(index: number): string {
  return `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

export async function reconcile(
  sql: Sql,
  index: number,
  options: { dispatchable?: boolean; labels?: string[]; state?: string;
    url?: string | null; createdAt?: Date | null } = {},
): Promise<Candidate> {
  const id = issueId(index)
  const dispatchable = options.dispatchable ?? true
  const rows = await sql<Candidate[]>`
    select candidate_id::text, generation::integer, generation_state,
      snapshot_version::integer, scheduler_eligible
    from momi_agent_ops.reconcile_scheduler_candidate_v1(
      ${routeKey}, ${projectId}::uuid, ${id}::uuid, ${`MOX-${index}`},
      ${options.url === undefined ? `https://linear.app/mox/issue/MOX-${index}/test`
        : options.url},
      ${options.state ?? "Todo"}, 2, ${options.createdAt ?? new Date(0)}::timestamptz,
      now(), ${options.labels ?? ["implementation", "ready-package"]}::text[],
      ${dispatchable}, ${dispatchable ? [] : ["blocker_not_accepted"]}::text[]
    )
  `
  if (rows.length !== 1) throw new Error("scheduler candidate reconcile returned no row")
  return rows[0]
}

export async function acquire(
  sql: Sql,
  owner: string,
  sha = releaseSha,
): Promise<{ route_key: string; fencing_generation: number } | null> {
  const rows = await sql<{ route_key: string; fencing_generation: number }[]>`
    select route_key, fencing_generation::integer
    from momi_agent_ops.acquire_scheduler_leader_v1(
      ${routeKey}, ${owner}::uuid, ${sha}
    )
  `
  return rows[0] ?? null
}

export async function hasImplementationCapacity(
  sql: Sql,
  owner: string,
  leaderGeneration: number,
  sha = releaseSha,
): Promise<boolean> {
  const [row] = await sql<{ available: boolean }[]>`
    select momi_agent_ops.scheduler_route_has_implementation_capacity_v1(
      ${routeKey}, ${owner}::uuid, ${sha}, ${leaderGeneration}
    ) as available
  `
  return row?.available === true
}

export async function claim(
  sql: Sql,
  owner: string,
  leaderGeneration: number,
  candidate: Candidate,
  sha = releaseSha,
): Promise<Claim> {
  const rows = await sql<Claim[]>`
    select claimed, dispatch_id::text
    from momi_agent_ops.claim_scheduler_candidate_v1(
      ${routeKey}, ${owner}::uuid, ${sha}, ${leaderGeneration},
      ${candidate.candidate_id}::uuid, ${candidate.generation},
      ${candidate.snapshot_version}
    )
  `
  if (rows.length !== 1) throw new Error("scheduler claim returned no row")
  return rows[0]
}

export async function configure(
  sql: Sql,
  mode: "disabled" | "observe" | "enabled",
  acceptanceIssueIds: string[] = [],
): Promise<void> {
  await sql`
    update momi_agent_ops.scheduler_route_policies
    set mode = ${mode}, acceptance_issue_ids = ${acceptanceIssueIds}::uuid[],
      accepted_release_sha = case when ${mode} = 'enabled' then ${releaseSha} else null end,
      acceptance_completed_at = case when ${mode} = 'enabled' then now() else null end,
      provider_retry_count = 0, next_provider_attempt_at = now(),
      max_concurrent = 3, implementation_limit = 3,
      coordinator_limit = 1, shared_limit = 1
    where route_key = ${routeKey}
  `
}
