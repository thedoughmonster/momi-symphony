import assert from "node:assert/strict"

import postgres, { type Sql } from "postgres"

import {
  acquire,
  claim,
  configure,
  issueId,
  ownerOne,
  ownerThree,
  ownerTwo,
  reconcile,
  releaseSha,
  routeKey,
  wrongReleaseSha,
  type Candidate,
} from "./contract.ts"

export async function assertDefaultAndReleaseFencing(sql: Sql, url: string): Promise<void> {
  const [initial] = await sql<{ mode: string; acceptance_issue_ids: string[] }[]>`
    select mode, acceptance_issue_ids::text[]
    from momi_agent_ops.scheduler_route_policies where route_key = ${routeKey}
  `
  assert.deepEqual(initial, { mode: "disabled", acceptance_issue_ids: [] })
  assert.equal(await acquire(sql, ownerOne), null)

  await configure(sql, "observe", [issueId(1)])
  const firstLeader = await acquire(sql, ownerOne)
  assert.equal(firstLeader?.fencing_generation, 1)
  assert.equal(await acquire(sql, ownerTwo), null)

  const restarted = postgres(url, { max: 1, prepare: false })
  try {
    const [persisted] = await restarted<{ mode: string; acceptance_issue_ids: string[] }[]>`
      select mode, acceptance_issue_ids::text[]
      from momi_agent_ops.scheduler_route_policies where route_key = ${routeKey}
    `
    assert.deepEqual(persisted, { mode: "observe", acceptance_issue_ids: [issueId(1)] })
  } finally {
    await restarted.end({ timeout: 2 })
  }

  const observed = await reconcile(sql, 1)
  assert.equal((await claim(sql, ownerOne, 1, observed)).claimed, false)
  await sql`update momi_agent_ops.scheduler_leaders set lease_expires_at = now() - interval '1 second'`
  const secondLeader = await acquire(sql, ownerTwo)
  assert.equal(secondLeader?.fencing_generation, 2)

  await assert.rejects(sql`
    update momi_agent_ops.scheduler_route_policies
    set mode = 'enabled', acceptance_issue_ids = '{}'::uuid[]
    where route_key = ${routeKey}
  `, /scheduler_route_policies_check/)
  await configure(sql, "enabled")
  await sql`update momi_agent_ops.scheduler_leaders set lease_expires_at = now() - interval '1 second'`
  assert.equal(await acquire(sql, ownerThree, wrongReleaseSha), null)
  const thirdLeader = await acquire(sql, ownerThree)
  assert.equal(thirdLeader?.fencing_generation, 3)
  assert.equal((await claim(sql, ownerTwo, 2, observed)).claimed, false)
  assert.equal((await claim(sql, ownerThree, 3, observed, wrongReleaseSha)).claimed, false)
  assert.equal((await claim(sql, ownerThree, 3, observed)).claimed, true)
}

export async function assertTransactionalAcceptanceRollback(sql: Sql): Promise<void> {
  await assert.rejects(sql.begin(async (transaction) => {
    const candidate = await reconcile(transaction as Sql, 9)
    const result = await claim(transaction as Sql, ownerThree, 3, candidate)
    assert.equal(result.claimed, true)
    throw new Error("intentional_acceptance_rollback")
  }), /intentional_acceptance_rollback/)
  const [evidence] = await sql<{ candidates: number; dispatches: number; slots: number }[]>`
    select
      (select count(*)::integer from momi_agent_ops.scheduler_candidates
        where linear_issue_id = ${issueId(9)}::uuid) as candidates,
      (select count(*)::integer from momi_agent_ops.dispatches
        where linear_issue_id = ${issueId(9)}::uuid) as dispatches,
      (select count(*)::integer from momi_agent_ops.scheduler_slots slot
        join momi_agent_ops.scheduler_candidates candidate
          on candidate.candidate_id = slot.candidate_id
        where candidate.linear_issue_id = ${issueId(9)}::uuid) as slots
  `
  assert.deepEqual(evidence, { candidates: 0, dispatches: 0, slots: 0 })
}

async function activeCount(sql: Sql): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::integer from momi_agent_ops.scheduler_slots
    where state in ('reserved', 'running', 'quarantined')
  `
  return row.count
}

async function releaseOne(sql: Sql): Promise<boolean> {
  const rows = await sql<{ dispatch_id: string }[]>`
    select dispatch_id::text from momi_agent_ops.scheduler_slots
    where state in ('reserved', 'running', 'quarantined')
    order by created_at, dispatch_id limit 1
  `
  if (!rows[0]) return false
  await sql`
    update momi_agent_ops.dispatches
    set work_status = 'completed', completed_at = now()
    where dispatch_id = ${rows[0].dispatch_id}::uuid
  `
  return true
}

export async function assertContentionAndRecovery(sql: Sql): Promise<void> {
  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where source_kind = 'ready_leaf_scheduler' and work_status <> 'completed'
  `
  const leader = await acquire(sql, ownerThree)
  assert.equal(leader?.fencing_generation, 3)
  const candidates: Candidate[] = []
  for (let index = 10; index < 30; index += 1) {
    candidates.push(await reconcile(sql, index))
  }

  const firstWave = await Promise.all(candidates.map((candidate) =>
    claim(sql, ownerThree, 3, candidate)))
  assert.equal(firstWave.filter((result) => result.claimed).length, 3)
  assert.equal(await activeCount(sql), 3)
  let maximum = 3

  while (true) {
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::integer from momi_agent_ops.dispatches
      where source_kind = 'ready_leaf_scheduler'
        and scheduler_candidate_id = any (${candidates.map((candidate) =>
          candidate.candidate_id)}::uuid[])
    `
    if (count === candidates.length) break
    assert.equal(await releaseOne(sql), true)
    const wave = await Promise.all(candidates.map((candidate) =>
      claim(sql, ownerThree, 3, candidate)))
    assert.ok(wave.filter((result) => result.claimed).length <= 1)
    maximum = Math.max(maximum, await activeCount(sql))
    assert.ok(await activeCount(sql) <= 3)
  }
  assert.equal(maximum, 3)
  assert.equal(await activeCount(sql), 3)
  assert.equal((await claim(sql, ownerThree, 3, candidates[0])).claimed, false)

  const [{ duplicates, parented }] = await sql<{ duplicates: number; parented: number }[]>`
    select count(*)::integer - count(distinct (scheduler_candidate_id,
      scheduler_generation))::integer as duplicates,
      count(*) filter (where parent_dispatch_id is not null)::integer as parented
    from momi_agent_ops.dispatches where source_kind = 'ready_leaf_scheduler'
  `
  assert.deepEqual({ duplicates, parented }, { duplicates: 0, parented: 0 })

  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where source_kind = 'ready_leaf_scheduler' and work_status <> 'completed'
  `
  await sql`
    update momi_agent_ops.scheduler_route_policies
    set max_concurrent = 1, implementation_limit = 1,
      coordinator_limit = 1, shared_limit = 1
    where route_key = ${routeKey}
  `
  const expiring = await reconcile(sql, 31)
  const expiringClaim = await claim(sql, ownerThree, 3, expiring)
  assert.equal(expiringClaim.claimed, true)
  await sql`
    update momi_agent_ops.scheduler_slots
    set lease_expires_at = now() - interval '1 second'
    where dispatch_id = ${expiringClaim.dispatch_id}::uuid
  `
  const [heartbeat] = await sql<{ quarantined: number; active_quarantines: number }[]>`
    select quarantined, active_quarantines
    from momi_agent_ops.heartbeat_scheduler_slots_v2('{}'::uuid[])
  `
  assert.deepEqual(heartbeat, { quarantined: 1, active_quarantines: 1 })
  const waiting = await reconcile(sql, 32)
  assert.equal((await claim(sql, ownerThree, 3, waiting)).claimed, false)
  const [extended] = await sql<{ extended: number }[]>`
    select extended from momi_agent_ops.heartbeat_scheduler_slots_v2(
      array[${expiringClaim.dispatch_id}::uuid]
    )
  `
  assert.equal(extended.extended, 0)
  assert.equal((await claim(sql, ownerThree, 3, waiting)).claimed, false)

  await sql`
    update momi_agent_ops.scheduler_issue_quarantines
    set quarantined_at = now() - interval '31 seconds',
      intervention_deadline_at = now() - interval '1 second'
    where dispatch_id = ${expiringClaim.dispatch_id}::uuid
  `
  const [released] = await sql<{ capacity_released: number;
    active_quarantines: number; manual_interventions: number }[]>`
    select capacity_released, active_quarantines, manual_interventions
    from momi_agent_ops.heartbeat_scheduler_slots_v2('{}'::uuid[])
  `
  assert.deepEqual(released, { capacity_released: 1,
    active_quarantines: 1, manual_interventions: 1 })
  assert.equal((await claim(sql, ownerThree, 3, expiring)).claimed, false)
  assert.equal((await claim(sql, ownerThree, 3, waiting)).claimed, true)

  const [fence] = await sql<{ slot_state: string; capacity_released_at: Date | null;
    resolved_at: Date | null }[]>`
    select slot.state as slot_state, quarantine.capacity_released_at,
      quarantine.resolved_at
    from momi_agent_ops.scheduler_issue_quarantines quarantine
    join momi_agent_ops.scheduler_slots slot using (dispatch_id)
    where quarantine.dispatch_id = ${expiringClaim.dispatch_id}::uuid
  `
  assert.equal(fence.slot_state, "released")
  assert.ok(fence.capacity_released_at)
  assert.equal(fence.resolved_at, null)
  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where dispatch_id = ${expiringClaim.dispatch_id}::uuid
  `
  const [{ resolved }] = await sql<{ resolved: boolean }[]>`
    select resolved_at is not null as resolved
    from momi_agent_ops.scheduler_issue_quarantines
    where dispatch_id = ${expiringClaim.dispatch_id}::uuid
  `
  assert.equal(resolved, true)
}

export async function assertGenerationRefreshAndStaleLeader(sql: Sql): Promise<void> {
  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where source_kind = 'ready_leaf_scheduler' and work_status <> 'completed'
  `
  const blocked = await reconcile(sql, 40, { dispatchable: false })
  assert.deepEqual([blocked.generation, blocked.generation_state,
    blocked.scheduler_eligible], [0, "waiting", false])
  const ready = await reconcile(sql, 40, { dispatchable: true })
  assert.deepEqual([ready.generation, ready.generation_state,
    ready.scheduler_eligible], [1, "eligible", true])
  const firstClaim = await claim(sql, ownerThree, 3, ready)
  assert.equal(firstClaim.claimed, true)
  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where dispatch_id = ${firstClaim.dispatch_id}::uuid
  `
  const drifted = await reconcile(sql, 40, { dispatchable: false })
  assert.equal(drifted.generation, 1)
  const nextGeneration = await reconcile(sql, 40, { dispatchable: true })
  assert.deepEqual([nextGeneration.generation, nextGeneration.generation_state],
    [2, "eligible"])

  await sql`update momi_agent_ops.scheduler_leaders set lease_expires_at = now() - interval '1 second'`
  const nextLeader = await acquire(sql, ownerTwo)
  assert.equal(nextLeader?.fencing_generation, 4)
  assert.equal((await claim(sql, ownerThree, 3, nextGeneration)).claimed, false)
  assert.equal((await claim(sql, ownerTwo, 4, nextGeneration)).claimed, true)

  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where source_kind = 'ready_leaf_scheduler' and work_status <> 'completed'
  `
  const staleSnapshot = await reconcile(sql, 41)
  await sql`
    update momi_agent_ops.scheduler_candidates
    set last_reconciled_at = now() - interval '31 seconds'
    where candidate_id = ${staleSnapshot.candidate_id}::uuid
  `
  assert.equal((await claim(sql, ownerTwo, 4, staleSnapshot)).claimed, false)

  await configure(sql, "disabled")
  const restarted = await acquire(sql, ownerOne)
  assert.equal(restarted, null)
  const [{ mode }] = await sql<{ mode: string }[]>`
    select mode from momi_agent_ops.scheduler_route_policies where route_key = ${routeKey}
  `
  assert.equal(mode, "disabled")
}
