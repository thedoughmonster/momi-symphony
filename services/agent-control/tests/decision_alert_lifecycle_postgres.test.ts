import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"

import postgres, { type Sql } from "postgres"

const migrationPath = "supabase/migrations/20260819082707_add_decision_alert_lifecycle.sql"
const projectId = "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5"
const issueId = "11111111-1111-4111-8111-111111111111"
const commentId = "22222222-2222-4222-8222-222222222222"
const releaseSha = "a".repeat(40)

function docker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim())
  return result.stdout.trim()
}

async function connect(container: string): Promise<Sql> {
  const port = Number(docker(["port", container, "5432/tcp"]).match(/:(\d+)$/)?.[1])
  const url = `postgres://postgres:momi-agent-test@127.0.0.1:${port}/postgres`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const sql = postgres(url, { connect_timeout: 2, max: 4, prepare: false })
    try { await sql`select 1`; return sql } catch {
      await sql.end({ timeout: 1 }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error("Disposable PostgreSQL did not start")
}

type Wake = { disposition: string; work_id: string | null; capability_token: string | null }

async function reconcile(
  sql: Sql,
  options: { issueId?: string; commentId?: string; key?: string;
    identifier?: string; status?: "unresolved" | "resolved"; resolution?: string | null } = {},
): Promise<Wake> {
  const currentIssue = options.issueId ?? issueId
  const currentComment = options.commentId ?? commentId
  const key = options.key ?? "mox-232-acceptance"
  const identifier = options.identifier ?? "MOX-232"
  const status = options.status ?? "unresolved"
  const resolution = options.resolution ?? null
  const identity = `linear:${currentIssue}:${currentComment}:${key}`
  const rows = await sql<Wake[]>`
    select disposition, work_id::text, capability_token::text
    from momi_agent_ops.reconcile_decision_alert_v1(
      ${projectId}::uuid, ${currentIssue}::uuid, ${identifier},
      ${"Decision acceptance fixture"},
      ${`https://linear.app/moxx-workboard/issue/${identifier}/fixture`},
      ${currentComment}::uuid, ${key}, ${identity},
      ${"material_architecture_ownership"}, ${status},
      ${"Should the controlled acceptance use the governed development alerts destination?"},
      ${"Repository policy cannot select an operator-owned Slack destination."},
      ${"Use the existing disabled development alerts destination for one acceptance."},
      ${["Stop before delivery", "Create another authorized destination"]}::text[],
      ${["One sanitized development alert", "Production remains untouched"]}::text[],
      ${[identifier]}::text[], ${resolution}
    )
  `
  return rows[0]
}

test("decision alert lifecycle is default-off, deduplicated, restart-safe, and fail-closed", async (context) => {
  const container = `momi-decision-alert-${process.pid}-${Date.now()}`
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
    create schema momi_agent_ops;
    create table momi_agent_ops.project_mappings (
      linear_project_id uuid primary key,
      linear_project_name text not null,
      repository text not null,
      base_branch text not null,
      active_states text[] not null,
      active boolean not null,
      host_dispatch_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    insert into momi_agent_ops.project_mappings (
      linear_project_id, linear_project_name, repository, base_branch,
      active_states, active, host_dispatch_url
    ) values (
      '${projectId}', 'Symphony Control Plane', 'thedoughmonster/momi-symphony',
      'main', array['Todo'], true, 'https://private.example.invalid/dispatch'
    );
  `)
  await sql.unsafe(await readFile(migrationPath, "utf8"))

  const [preflight] = await sql<{ route_mode: string; destination_configured: boolean;
    release_configured: boolean }[]>`select * from momi_agent_ops.decision_alert_preflight_v1()`
  assert.deepEqual(preflight, { route_mode: "disabled", destination_configured: false,
    release_configured: false })
  const disabled = await reconcile(sql)
  assert.deepEqual(disabled, { disposition: "disabled", work_id: null, capability_token: null })
  assert.equal((await sql`select count(*)::int as count from momi_agent_ops.decision_alerts`)[0].count, 1)
  assert.equal((await sql`select count(*)::int as count from momi_agent_ops.decision_delivery_work`)[0].count, 0)

  await assert.rejects(sql`select momi_agent_ops.configure_decision_alert_acceptance_v1(
    ${"wrong"}, ${"CINVALID"}, ${issueId}::uuid, ${releaseSha}
  )`, /decision_acceptance_configuration_invalid/)
  await sql`select momi_agent_ops.configure_decision_alert_acceptance_v1(
    ${"momi_dev_alerts"}, ${"C0BGPEE4A4V"}, ${issueId}::uuid, ${releaseSha}
  )`

  const first = await reconcile(sql)
  assert.equal(first.disposition, "delivery_ready_initial")
  const duplicateBeforeClaim = await reconcile(sql)
  assert.equal(duplicateBeforeClaim.work_id, first.work_id)
  assert.notEqual(duplicateBeforeClaim.capability_token, first.capability_token)
  assert.equal((await sql`select count(*)::int as count from momi_agent_ops.claim_decision_delivery_v1(
    ${first.work_id}::uuid, ${first.capability_token}::uuid
  )`)[0].count, 0)
  const claimed = await sql<{ attempt_id: string; slack_channel_id: string }[]>`
    select attempt_id::text, slack_channel_id
    from momi_agent_ops.claim_decision_delivery_v1(
      ${duplicateBeforeClaim.work_id}::uuid, ${duplicateBeforeClaim.capability_token}::uuid
    )
  `
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].slack_channel_id, "C0BGPEE4A4V")
  assert.equal((await sql`select count(*)::int as count
    from momi_agent_ops.decision_delivery_attempts where outcome = 'started'`)[0].count, 1)
  assert.equal((await sql`select momi_agent_ops.finalize_decision_delivery_v1(
    ${duplicateBeforeClaim.work_id}::uuid, ${duplicateBeforeClaim.capability_token}::uuid,
    ${claimed[0].attempt_id}::uuid, 'delivered', 200, null,
    'C0BGPEE4A4V', '1787128000.000100', null
  ) as recorded`)[0].recorded, true)
  assert.equal((await reconcile(sql)).disposition, "duplicate")
  assert.equal((await sql`select count(*)::int as count from momi_agent_ops.decision_delivery_attempts`)[0].count, 1)

  const resolution = await reconcile(sql, { status: "resolved",
    resolution: "Use the governed development alerts destination." })
  assert.equal(resolution.disposition, "delivery_ready_resolution")
  const resolutionClaim = await sql<{ attempt_id: string; delivery_kind: string;
    slack_thread_ts: string }[]>`
    select attempt_id::text, delivery_kind, slack_thread_ts
    from momi_agent_ops.claim_decision_delivery_v1(
      ${resolution.work_id}::uuid, ${resolution.capability_token}::uuid
    )
  `
  assert.deepEqual(resolutionClaim.map(({ delivery_kind, slack_thread_ts }) =>
    ({ delivery_kind, slack_thread_ts })), [{
      delivery_kind: "resolution", slack_thread_ts: "1787128000.000100",
    }])
  assert.equal((await sql`select momi_agent_ops.finalize_decision_delivery_v1(
    ${resolution.work_id}::uuid, ${resolution.capability_token}::uuid,
    ${resolutionClaim[0].attempt_id}::uuid, 'delivered', 200, null,
    'C0BGPEE4A4V', '1787128001.000200', null
  ) as recorded`)[0].recorded, true)
  assert.equal((await reconcile(sql, { status: "resolved",
    resolution: "Use the governed development alerts destination." })).disposition,
    "duplicate_resolution")
  const [resolved] = await sql<{ lifecycle_state: string; attempts: number }[]>`
    select lifecycle_state, (select count(*)::int
      from momi_agent_ops.decision_delivery_attempts) as attempts
    from momi_agent_ops.decision_alerts where linear_issue_id = ${issueId}::uuid
  `
  assert.deepEqual(resolved, { lifecycle_state: "resolved", attempts: 2 })

  const ambiguousIssue = "33333333-3333-4333-8333-333333333333"
  const ambiguousComment = "44444444-4444-4444-8444-444444444444"
  await sql`update momi_agent_ops.decision_alert_policies set
    acceptance_issue_ids = array[${ambiguousIssue}::uuid]`
  const ambiguousWake = await reconcile(sql, { issueId: ambiguousIssue,
    commentId: ambiguousComment, key: "ambiguous-fixture", identifier: "MOX-999" })
  const ambiguousClaim = await sql<{ attempt_id: string }[]>`
    select attempt_id::text from momi_agent_ops.claim_decision_delivery_v1(
      ${ambiguousWake.work_id}::uuid, ${ambiguousWake.capability_token}::uuid
    )
  `
  assert.equal(ambiguousClaim.length, 1)
  await sql`update momi_agent_ops.decision_delivery_work set lease_expires_at = now() - interval '1 second'
    where work_id = ${ambiguousWake.work_id}::uuid`
  assert.equal((await sql`select count(*)::int as count
    from momi_agent_ops.claim_decision_delivery_v1(
      ${ambiguousWake.work_id}::uuid, ${ambiguousWake.capability_token}::uuid
    )`)[0].count, 0)
  assert.equal((await reconcile(sql, { issueId: ambiguousIssue,
    commentId: ambiguousComment, key: "ambiguous-fixture", identifier: "MOX-999" })).disposition,
    "duplicate")
  assert.equal((await sql`select count(*)::int as count
    from momi_agent_ops.decision_delivery_attempts
    where work_id = ${ambiguousWake.work_id}::uuid`)[0].count, 1)

  const retryIssue = "55555555-5555-4555-8555-555555555555"
  const retryComment = "66666666-6666-4666-8666-666666666666"
  await sql`update momi_agent_ops.decision_alert_policies set
    acceptance_issue_ids = array[${retryIssue}::uuid]`
  const retryWake = await reconcile(sql, { issueId: retryIssue,
    commentId: retryComment, key: "retryable-fixture", identifier: "MOX-998" })
  const retryClaim = await sql<{ attempt_id: string }[]>`
    select attempt_id::text from momi_agent_ops.claim_decision_delivery_v1(
      ${retryWake.work_id}::uuid, ${retryWake.capability_token}::uuid
    )
  `
  assert.equal((await sql`select momi_agent_ops.finalize_decision_delivery_v1(
    ${retryWake.work_id}::uuid, ${retryWake.capability_token}::uuid,
    ${retryClaim[0].attempt_id}::uuid, 'retryable', 429, 17,
    null, null, 'slack_rate_limited'
  ) as recorded`)[0].recorded, true)
  assert.equal((await reconcile(sql, { issueId: retryIssue,
    commentId: retryComment, key: "retryable-fixture", identifier: "MOX-998" })).disposition,
    "retry_wait")
  await sql`update momi_agent_ops.decision_delivery_work set next_attempt_at = now()
    where work_id = ${retryWake.work_id}::uuid`
  const retryWake2 = await reconcile(sql, { issueId: retryIssue,
    commentId: retryComment, key: "retryable-fixture", identifier: "MOX-998" })
  assert.equal(retryWake2.work_id, retryWake.work_id)
  assert.notEqual(retryWake2.capability_token, retryWake.capability_token)
  const retryClaim2 = await sql<{ attempt_id: string }[]>`
    select attempt_id::text from momi_agent_ops.claim_decision_delivery_v1(
      ${retryWake2.work_id}::uuid, ${retryWake2.capability_token}::uuid
    )
  `
  assert.equal((await sql`select momi_agent_ops.finalize_decision_delivery_v1(
    ${retryWake2.work_id}::uuid, ${retryWake2.capability_token}::uuid,
    ${retryClaim2[0].attempt_id}::uuid, 'delivered', 200, null,
    'C0BGPEE4A4V', '1787128002.000300', null
  ) as recorded`)[0].recorded, true)
  assert.equal((await sql`select count(*)::int as count
    from momi_agent_ops.decision_delivery_attempts
    where work_id = ${retryWake.work_id}::uuid`)[0].count, 2)

  await sql`select momi_agent_ops.disable_decision_alert_delivery_v1()`
  const [finalPolicy] = await sql<{ mode: string; acceptance_count: number }[]>`
    select mode, cardinality(acceptance_issue_ids) as acceptance_count
    from momi_agent_ops.decision_alert_policies
  `
  assert.deepEqual(finalPolicy, { mode: "disabled", acceptance_count: 0 })
})
