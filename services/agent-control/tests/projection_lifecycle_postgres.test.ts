import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import postgres, { type Sql } from "postgres"

import { loadManagedMigrations } from "../../../scripts/symphony_migrations.ts"
import { acquire, configure, ownerOne, reconcile, releaseSha, routeKey,
  type Candidate, type Claim } from
  "./ready_leaf_scheduler_postgres/contract.ts"

async function claimBeforeQuarantine(sql: Sql, candidate: Candidate): Promise<Claim> {
  const rows = await sql<Claim[]>`
    select claimed, dispatch_id::text
    from momi_agent_ops.claim_scheduler_candidate_v2(
      ${routeKey}, ${ownerOne}::uuid, ${releaseSha}, 1,
      ${candidate.candidate_id}::uuid, ${candidate.generation},
      ${candidate.snapshot_version}
    )
  `
  if (rows.length !== 1) throw new Error("scheduler claim returned no row")
  return rows[0]
}

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024, timeout: 180_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim())
  return result.stdout.trim()
}

async function connect(container: string): Promise<Sql> {
  const port = Number(docker(["port", container, "5432/tcp"]).match(/:(\d+)$/)?.[1])
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const sql = postgres(`postgres://postgres:momi-agent-test@127.0.0.1:${port}/postgres`,
      { connect_timeout: 2, max: 16, prepare: false })
    try { await sql`select 1`; return sql } catch {
      await sql.end({ timeout: 1 }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error("Disposable PostgreSQL did not start")
}

test("migration backfills in-flight runs and projection claims are atomic", async (context) => {
  const container = `momi-projection-${process.pid}-${Date.now()}`
  docker(["run", "--detach", "--rm", "--name", container,
    "--env", "POSTGRES_PASSWORD=momi-agent-test",
    "--publish", "127.0.0.1::5432", "postgres:17-alpine"])
  const sql = await connect(container)
  context.after(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined)
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" })
  })
  await sql.unsafe(`
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create schema vault;
    create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
    create schema net;
    create function net.http_post(url text, headers jsonb, body jsonb,
      timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron;
    create function cron.schedule(name text, schedule text, command text)
      returns bigint language sql as 'select 1::bigint';
  `)
  const { migrations } = await loadManagedMigrations()
  const projectionIndex = migrations.findIndex((migration) =>
    migration.name.includes("simplify_readiness_and_decouple_projection"))
  assert.ok(projectionIndex > 7)
  const projection = migrations[projectionIndex]
  assert.match(projection.name, /simplify_readiness_and_decouple_projection/)
  for (const migration of migrations.slice(0, 7)) await sql.unsafe(migration.sql)
  await sql`
    update momi_agent_ops.project_mappings set
      host_dispatch_url = 'https://host.example/v1/dispatch'
    where linear_project_name = 'Backend Stabilization'
  `
  for (const migration of migrations.slice(7, projectionIndex)) await sql.unsafe(migration.sql)
  await configure(sql, "enabled")
  const leader = await acquire(sql, ownerOne)
  assert.equal(leader?.fencing_generation, 1)
  const pendingClaim = await claimBeforeQuarantine(sql, await reconcile(sql, 501))
  const projectedClaim = await claimBeforeQuarantine(sql, await reconcile(sql, 502))
  const runningClaim = await claimBeforeQuarantine(sql, await reconcile(sql, 503))
  for (const id of [pendingClaim.dispatch_id, projectedClaim.dispatch_id]) {
    assert.ok(id)
    await sql`
      update momi_agent_ops.dispatches set codex_thread_id = 'thread', codex_turn_id = 'turn',
        host_accepted_at = now(), work_status = 'active' where dispatch_id = ${id}::uuid
    `
  }
  await sql`
    update momi_agent_ops.dispatches set work_status = 'completed', completed_at = now()
    where dispatch_id in (${pendingClaim.dispatch_id}::uuid, ${projectedClaim.dispatch_id}::uuid)
  `
  await sql`
    update momi_agent_ops.run_records set readiness_result = 'ready',
      terminal_disposition = 'completed', terminal_at = now(), archive_state = 'archived',
      archived_at = now()
    where dispatch_id in (${pendingClaim.dispatch_id}::uuid, ${projectedClaim.dispatch_id}::uuid)
  `
  await sql`
    update momi_agent_ops.run_records set linear_writeback_at = now()
    where dispatch_id = ${projectedClaim.dispatch_id}::uuid
  `
  const [rollbackIdentity] = await sql<{ capability_token: string }[]>`
    select wake_capability_token::text as capability_token
    from momi_agent_ops.dispatches
    where dispatch_id = ${runningClaim.dispatch_id}::uuid
  `
  await sql`select * from momi_agent_ops.claim_dispatch_v5(
    ${runningClaim.dispatch_id}::uuid, ${rollbackIdentity.capability_token}::uuid)`
  const [accepted] = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_host_acceptance_v1(
      ${runningClaim.dispatch_id}::uuid, ${rollbackIdentity.capability_token}::uuid,
      'rollback-thread', 'rollback-turn'
    ) as recorded
  `
  assert.equal(accepted.recorded, true)

  await sql.unsafe(projection.sql)
  const backfill = await sql<{ dispatch_id: string; execution_status: string;
    linear_projection_status: string }[]>`
    select dispatch_id::text, execution_status, linear_projection_status
    from momi_agent_ops.run_records
    where dispatch_id in (${pendingClaim.dispatch_id}::uuid,
      ${projectedClaim.dispatch_id}::uuid, ${runningClaim.dispatch_id}::uuid)
    order by dispatch_id
  `
  const statuses = new Map(backfill.map((row) => [row.dispatch_id, row]))
  assert.deepEqual(statuses.get(pendingClaim.dispatch_id!), {
    dispatch_id: pendingClaim.dispatch_id, execution_status: "succeeded",
    linear_projection_status: "retryable" })
  assert.deepEqual(statuses.get(projectedClaim.dispatch_id!), {
    dispatch_id: projectedClaim.dispatch_id, execution_status: "succeeded",
    linear_projection_status: "succeeded" })
  assert.deepEqual(statuses.get(runningClaim.dispatch_id!), {
    dispatch_id: runningClaim.dispatch_id, execution_status: "running",
    linear_projection_status: "pending" })

  const contention = await Promise.all(Array.from({ length: 8 }, () => sql<{
    dispatch_id: string; projection_attempt: number }[]>`
    select dispatch_id::text, projection_attempt::integer
    from momi_agent_ops.claim_terminal_projection_v1(${pendingClaim.dispatch_id}::uuid)
  `))
  assert.equal(contention.filter((rows) => rows.length === 1).length, 1)
  const firstAttempt = contention.find((rows) => rows.length === 1)![0].projection_attempt
  assert.equal(firstAttempt, 1)
  const [lease] = await sql<{ realistic_duration: boolean }[]>`
    select linear_projection_lease_expires_at >=
      linear_projection_last_attempt_at + interval '9 minutes' as realistic_duration
    from momi_agent_ops.run_records
    where dispatch_id = ${pendingClaim.dispatch_id}::uuid
  `
  assert.equal(lease.realistic_duration, true)
  await sql`
    update momi_agent_ops.run_records set
      linear_projection_lease_expires_at = now() - interval '1 second',
      linear_projection_next_attempt_at = now()
    where dispatch_id = ${pendingClaim.dispatch_id}::uuid
  `
  const [reclaimed] = await sql<{ projection_attempt: number }[]>`
    select projection_attempt::integer
    from momi_agent_ops.claim_terminal_projection_v1(${pendingClaim.dispatch_id}::uuid)
  `
  assert.equal(reclaimed.projection_attempt, 2)
  const staleCommentId = "30000000-0000-4000-8000-000000000099"
  const [stale] = await sql<{ status: string | null }[]>`
    select momi_agent_ops.record_terminal_projection_result_v1(
      ${pendingClaim.dispatch_id}::uuid, ${firstAttempt}, true,
      ${staleCommentId}::uuid, null
    ) as status
  `
  assert.equal(stale.status, null)
  const [afterStale] = await sql<{ status: string; attempt: number;
    linear_writeback_at: string | null }[]>`
    select linear_projection_status as status,
      linear_projection_attempt_count::integer as attempt,
      linear_writeback_at::text
    from momi_agent_ops.run_records
    where dispatch_id = ${pendingClaim.dispatch_id}::uuid
  `
  assert.deepEqual(afterStale, {
    status: "in_progress", attempt: 2, linear_writeback_at: null })
  const [failed] = await sql<{ status: string }[]>`
    select momi_agent_ops.record_terminal_projection_result_v1(
      ${pendingClaim.dispatch_id}::uuid, ${reclaimed.projection_attempt},
      false, null, 'linear_outage'
    ) as status
  `
  assert.equal(failed.status, "retryable")
  await sql`select momi_agent_ops.requeue_terminal_projection_v1(
    ${pendingClaim.dispatch_id}::uuid)`
  const retry = await sql<{ dispatch_id: string; projection_attempt: number }[]>`
    select dispatch_id::text, projection_attempt::integer
    from momi_agent_ops.claim_terminal_projection_v1(${pendingClaim.dispatch_id}::uuid)
  `
  assert.equal(retry.length, 1)
  const commentId = "30000000-0000-4000-8000-000000000001"
  const [succeeded] = await sql<{ status: string }[]>`
    select momi_agent_ops.record_terminal_projection_result_v1(
      ${pendingClaim.dispatch_id}::uuid, ${retry[0].projection_attempt},
      true, ${commentId}::uuid, null
    ) as status
  `
  assert.equal(succeeded.status, "succeeded")
  assert.equal((await sql`
    select dispatch_id from momi_agent_ops.claim_terminal_projection_v1(
      ${pendingClaim.dispatch_id}::uuid)
  `).length, 0)

  const telemetry = {
    policy_version: "execution-efficiency.v1",
    stable_prefix_fingerprint: "rollback-stable",
    context_fingerprint: "rollback-context",
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 5,
    model_visible_tool_bytes: 100,
    model_turns: 1,
    no_progress_cycles: 0,
    subagents: 0,
    max_subagent_depth: 0,
    retries: 0,
    repeated_failure_fingerprints: 0,
    elapsed_ms: 120000,
    disposition: "completed",
  }
  const rollbackTerminal = await sql`
    select * from momi_agent_ops.record_terminal_v5(
      ${runningClaim.dispatch_id}::uuid, ${rollbackIdentity.capability_token}::uuid,
      'rollback-thread', 'rollback-turn', 'ready', 'completed',
      'Previous runtime completed after the v2 migration.', now(),
      ${sql.json(telemetry)}::jsonb
    )
  `
  assert.equal(rollbackTerminal.length, 1)
  const [rollbackStatus] = await sql<{ execution_status: string;
    linear_projection_status: string }[]>`
    select execution_status, linear_projection_status
    from momi_agent_ops.run_records
    where dispatch_id = ${runningClaim.dispatch_id}::uuid
  `
  assert.deepEqual(rollbackStatus, {
    execution_status: "succeeded", linear_projection_status: "pending" })
})
