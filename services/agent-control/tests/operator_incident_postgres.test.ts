import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"
import { acquire, claim, configure, issueId as schedulerIssueId, ownerOne, reconcile,
  releaseSha } from "./ready_leaf_scheduler_postgres/contract.ts"

const dispatchId = "67000000-0000-4000-8000-000000000001"
const issueId = "67000000-0000-4000-8000-000000000002"
const deliveryId = "67000000-0000-4000-8000-000000000003"
const capability = "67000000-0000-4000-8000-000000000004"
const reviewOne = "67000000-0000-4000-8000-000000000005"
const reviewTwo = "67000000-0000-4000-8000-000000000006"
const reviewCapabilityOne = "67000000-0000-4000-8000-000000000009"
const reviewCapabilityTwo = "67000000-0000-4000-8000-000000000010"
const repository = "thedoughmonster/momi-symphony"
const projectId = "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5"
const head = "a".repeat(40)
const base = "b".repeat(40)

test("operator incidents deduplicate exact generations, supersede new ones, and resolve once",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)
    await seedReview(database.sql, reviewOne, "67000000-0000-4000-8000-000000000007")

    const invalid = await database.sql<{ incident_id: string | null }[]>`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, '67000000-0000-4000-8000-000000000099'::uuid,
        'reviewer_ambiguous', ${`review:${reviewOne}`}, 'reviewing',
        'reconcile_reviewer_start', ${reviewOne}::uuid, null, now()
      )::text as incident_id`
    assert.equal(invalid[0]?.incident_id, null)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const opened = await database.sql<{ incident_id: string | null }[]>`
        select momi_agent_ops.record_operator_incident_v1(
          ${dispatchId}::uuid, ${reviewCapabilityOne}::uuid, 'reviewer_ambiguous',
          ${`review:${reviewOne}`}, 'reviewing', 'reconcile_reviewer_start',
          ${reviewOne}::uuid, null, now()
        )::text as incident_id`
      assert.ok(opened[0]?.incident_id)
    }
    const repeated = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state, category, generation_key, observation_count,
        guidance_code, repository, pull_request_number, head_sha
      from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid`
    assert.deepEqual({ ...repeated[0] }, { lifecycle_state: "ambiguous",
      category: "reviewer_ambiguous", generation_key: `review:${reviewOne}`,
      observation_count: 2, guidance_code: "reconcile_reviewer_start",
      repository, pull_request_number: "17", head_sha: head })

    await database.sql`
      update momi_agent_ops.review_attempts set state = 'failed',
        failure_reason = 'review_host_missing', terminal_at = now(), updated_at = now()
      where review_attempt_id = ${reviewOne}::uuid`
    await seedReview(database.sql, reviewTwo, "67000000-0000-4000-8000-000000000008")
    await database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${reviewCapabilityTwo}::uuid, 'reviewer_ambiguous',
        ${`review:${reviewTwo}`}, 'reviewing', 'reconcile_reviewer_start',
        ${reviewTwo}::uuid, null, now())`
    const generations = await database.sql<Array<Record<string, unknown>>>`
      select generation_key, lifecycle_state, resolution_code
      from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid
      order by generation_key`
    assert.deepEqual(generations.map((row) => ({ ...row })), [
      { generation_key: `review:${reviewOne}`, lifecycle_state: "resolved",
        resolution_code: "automatic_recovery" },
      { generation_key: `review:${reviewTwo}`, lifecycle_state: "ambiguous",
        resolution_code: null },
    ])

    const delayed = await database.sql<{ incident_id: string | null }[]>`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${reviewCapabilityOne}::uuid, 'reviewer_ambiguous',
        ${`review:${reviewOne}`}, 'reviewing', 'reconcile_reviewer_start',
        ${reviewOne}::uuid, null, now())::text as incident_id`
    assert.equal(delayed[0]?.incident_id, null)
    const afterDelayedOlderObservation = await database.sql<Array<Record<string, unknown>>>`
      select generation_key, lifecycle_state, resolution_code
      from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid
      order by generation_key`
    assert.deepEqual(afterDelayedOlderObservation.map((row) => ({ ...row })), generations.map(
      (row) => ({ ...row })))

    const firstResolution = await database.sql<{ affected: number }[]>`
      select momi_agent_ops.resolve_operator_incidents_v1(
        ${dispatchId}::uuid, ${capability}::uuid, 'operator_recovered', now()
      ) as affected`
    const replayedResolution = await database.sql<{ affected: number }[]>`
      select momi_agent_ops.resolve_operator_incidents_v1(
        ${dispatchId}::uuid, ${capability}::uuid, 'operator_recovered', now()
      ) as affected`
    assert.equal(firstResolution[0]?.affected, 1)
    assert.equal(replayedResolution[0]?.affected, 0)
  })

test("qualifying terminal failure opens one bounded incident across callback replay",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)
    const telemetry = { policy_version: "mox-execution-efficiency-v1",
      stable_prefix_fingerprint: "fnv1a64:1111111111111111",
      context_fingerprint: "fnv1a64:2222222222222222", input_tokens: 10,
      cached_input_tokens: 0, output_tokens: 2, model_visible_tool_bytes: 100,
      model_turns: 1, no_progress_cycles: 0, subagents: 0, max_subagent_depth: 0,
      retries: 0, repeated_failure_fingerprints: 0, elapsed_ms: 1000,
      disposition: "failed" }
    for (let replay = 0; replay < 2; replay += 1) {
      const recorded = await database.sql<Array<Record<string, unknown>>>`
        select * from momi_agent_ops.record_terminal_v6(
          ${dispatchId}::uuid, ${capability}::uuid, 'implementation-thread',
          'implementation-turn', 'failed', 'failed', 'bounded failure', now(),
          ${database.sql.json(telemetry)}::jsonb)`
      assert.equal(recorded.length, 1)
    }
    const incidents = await database.sql<Array<Record<string, unknown>>>`
      select category, lifecycle_state, lifecycle_phase, guidance_code,
        observation_count, generation_key, linear_issue_identifier
      from momi_agent_ops.operator_incidents`
    assert.equal(incidents.length, 1)
    assert.deepEqual({ ...incidents[0], generation_key: "bounded" }, {
      category: "terminal_failure", lifecycle_state: "active",
      lifecycle_phase: "terminal", guidance_code: "inspect_terminal_failure",
      observation_count: 2, generation_key: "bounded", linear_issue_identifier: "MOX-267",
    })
  })

test("a retained unready terminal opens one typed operator incident", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  await seedImplementation(database.sql)
  const telemetry = { policy_version: "mox-execution-efficiency-v1",
    stable_prefix_fingerprint: "fnv1a64:1111111111111111",
    context_fingerprint: "fnv1a64:2222222222222222", input_tokens: 10,
    cached_input_tokens: 0, output_tokens: 2, model_visible_tool_bytes: 100,
    model_turns: 1, no_progress_cycles: 0, subagents: 0, max_subagent_depth: 0,
    retries: 0, repeated_failure_fingerprints: 0, elapsed_ms: 1000,
    disposition: "completed" }
  await database.sql`
    select * from momi_agent_ops.record_terminal_v6(
      ${dispatchId}::uuid, ${capability}::uuid, 'implementation-thread',
      'implementation-turn', 'unready', 'completed', 'bounded operator action', now(),
      ${database.sql.json(telemetry)}::jsonb)`
  const incidents = await database.sql<Array<Record<string, unknown>>>`
    select category, lifecycle_state, lifecycle_phase, guidance_code
    from momi_agent_ops.operator_incidents`
  assert.deepEqual({ ...incidents[0] }, {
    category: "retained_task_ambiguous", lifecycle_state: "ambiguous",
    lifecycle_phase: "terminal", guidance_code: "reconcile_retained_task",
  })
})

test("successful terminals resolve incidents only after durable Linear writeback",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)
    await database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${capability}::uuid, 'run_ambiguous',
        'before-terminal-writeback', 'working', 'recover_dispatch', null, null, now())`
    await database.sql`
      update momi_agent_ops.run_records set merge_sha = ${head},
        release_state = 'succeeded', release_sha = ${head}
      where dispatch_id = ${dispatchId}::uuid`
    const telemetry = { policy_version: "mox-execution-efficiency-v1",
      stable_prefix_fingerprint: "fnv1a64:1111111111111111",
      context_fingerprint: "fnv1a64:2222222222222222", input_tokens: 10,
      cached_input_tokens: 0, output_tokens: 2, model_visible_tool_bytes: 100,
      model_turns: 1, no_progress_cycles: 0, subagents: 0, max_subagent_depth: 0,
      retries: 0, repeated_failure_fingerprints: 0, elapsed_ms: 1000,
      disposition: "completed" }
    await database.sql`
      select * from momi_agent_ops.record_terminal_v6(
        ${dispatchId}::uuid, ${capability}::uuid, 'implementation-thread',
        'implementation-turn', 'ready', 'completed', 'bounded success', now(),
        ${database.sql.json(telemetry)}::jsonb)`
    let incident = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state, resolution_code from momi_agent_ops.operator_incidents`
    assert.deepEqual(incident.map((row) => ({ ...row })), [{
      lifecycle_state: "ambiguous", resolution_code: null,
    }])
    const writeback = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_linear_writeback_v6(
        ${dispatchId}::uuid, ${capability}::uuid, null) as recorded`
    assert.equal(writeback[0]?.recorded, true)
    incident = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state, resolution_code from momi_agent_ops.operator_incidents`
    assert.deepEqual(incident.map((row) => ({ ...row })), [{
      lifecycle_state: "resolved", resolution_code: "completed",
    }])
  })

test("dead-letter recovery epochs open a fresh incident after re-exhaustion", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const preHostDispatch = "67000000-0000-4000-8000-000000000030"
  await seedAdditionalDispatch(database.sql, { dispatchId: preHostDispatch,
    deliveryId: "67000000-0000-4000-8000-000000000031", rejected: false })
  await database.sql`
    update momi_agent_ops.dispatches set attempt_count = 8, work_status = 'dead_letter'
    where dispatch_id = ${preHostDispatch}::uuid`
  await database.sql`
    update momi_agent_ops.dispatches set dead_letter_recovered_at = now(),
      dead_letter_recovery_owner_issue_identifier = 'MOX-999',
      dead_letter_recovery_from_attempt_count = 8,
      dead_letter_recovery_from_error_code = 'codex_host_delivery_failed',
      dead_letter_recovery_host_dispatch_url = 'https://host.example/v1/dispatch',
      attempt_count = 0, work_status = 'pending'
    where dispatch_id = ${preHostDispatch}::uuid`
  await database.sql`
    update momi_agent_ops.dispatches set attempt_count = 8, work_status = 'dead_letter'
    where dispatch_id = ${preHostDispatch}::uuid`
  const incidents = await database.sql<Array<Record<string, unknown>>>`
    select generation_key, lifecycle_state, category, guidance_code
    from momi_agent_ops.operator_incidents
    order by first_observed_at, incident_id`
  assert.equal(incidents.length, 2)
  assert.equal(incidents[0]?.lifecycle_state, "resolved")
  assert.equal(incidents[1]?.lifecycle_state, "ambiguous")
  assert.equal(incidents[1]?.category, "retained_task_ambiguous")
  assert.equal(incidents[1]?.guidance_code, "reconcile_retained_task")
  assert.notEqual(incidents[0]?.generation_key, incidents[1]?.generation_key)
})

test("accepted-host dead letters require retained-task reconciliation", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  await seedImplementation(database.sql)
  await database.sql`
    update momi_agent_ops.dispatches set attempt_count = 8, work_status = 'dead_letter'
    where dispatch_id = ${dispatchId}::uuid`
  const incidents = await database.sql<Array<Record<string, unknown>>>`
    select category, lifecycle_phase, guidance_code
    from momi_agent_ops.operator_incidents`
  assert.deepEqual(incidents.map((row) => ({ ...row })), [{
    category: "retained_task_ambiguous", lifecycle_phase: "working",
    guidance_code: "reconcile_retained_task",
  }])
})

test("dead-letter incidents stay fenced and scheduler work is not recoverable",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))

    await seedImplementation(database.sql)
    await seedAdditionalDispatch(database.sql, {
      dispatchId: "67000000-0000-4000-8000-000000000024",
      deliveryId: "67000000-0000-4000-8000-000000000025", rejected: false })
    await database.sql`
      update momi_agent_ops.dispatches set attempt_count = 8, work_status = 'dead_letter'
      where dispatch_id = ${dispatchId}::uuid`
    const stale = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state, resolution_code from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid`
    assert.deepEqual(stale.map((row) => ({ ...row })), [{
      lifecycle_state: "superseded", resolution_code: "generation_superseded",
    }])

    await configure(database.sql, "enabled")
    const candidate = await reconcile(database.sql, 267)
    const leader = await acquire(database.sql, ownerOne, releaseSha)
    assert.ok(leader)
    const scheduled = await claim(database.sql, ownerOne,
      leader.fencing_generation, candidate, releaseSha)
    assert.ok(scheduled.dispatch_id)
    await database.sql`
      update momi_agent_ops.dispatches set attempt_count = 8, work_status = 'dead_letter'
      where dispatch_id = ${scheduled.dispatch_id}::uuid`
    const retained = await database.sql<Array<Record<string, unknown>>>`
      select category, lifecycle_phase, lifecycle_state, guidance_code
      from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${scheduled.dispatch_id}::uuid`
    assert.deepEqual(retained.map((row) => ({ ...row })), [{
      category: "retained_task_ambiguous", lifecycle_phase: "scheduler",
      lifecycle_state: "ambiguous", guidance_code: "reconcile_retained_task",
    }])
  })

test("incident observations serialize with dispatch creation and stale slots stay fenced",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)

    let releaseLock = () => undefined
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve })
    let lockHeld = () => undefined
    const lockReady = new Promise<void>((resolve) => { lockHeld = resolve })
    const locker = database.sql.begin(async (transaction) => {
      await transaction`select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`momi_agent_ops.dispatch_generation:${issueId}`}, 0))`
      lockHeld()
      await lockGate
    })
    await lockReady
    let observationFinished = false
    const observation = database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${capability}::uuid, 'run_ambiguous',
        'concurrent-observation', 'working', 'recover_dispatch', null, null, now())
    `.then(() => { observationFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(observationFinished, false)
    releaseLock()
    await Promise.all([locker, observation])

    await configure(database.sql, "enabled")
    const candidate = await reconcile(database.sql, 268)
    const leader = await acquire(database.sql, ownerOne, releaseSha)
    assert.ok(leader)
    const scheduled = await claim(database.sql, ownerOne,
      leader.fencing_generation, candidate, releaseSha)
    assert.ok(scheduled.dispatch_id)
    await seedAdditionalDispatch(database.sql, {
      dispatchId: "67000000-0000-4000-8000-000000000026",
      deliveryId: "67000000-0000-4000-8000-000000000027", rejected: false,
      issueId: schedulerIssueId(268), identifier: "MOX-268" })
    await database.sql`
      update momi_agent_ops.scheduler_slots set state = 'quarantined'
      where dispatch_id = ${scheduled.dispatch_id}::uuid`
    const staleSlot = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state, resolution_code from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${scheduled.dispatch_id}::uuid
        and category = 'slot_ambiguous'`
    assert.deepEqual(staleSlot.map((row) => ({ ...row })), [{
      lifecycle_state: "superseded", resolution_code: "generation_superseded",
    }])
  })

test("rejected dispatches cannot displace guidance and pending reviews stay actionable",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)
    await seedReview(database.sql, reviewOne, "67000000-0000-4000-8000-000000000007")
    await database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${reviewCapabilityOne}::uuid, 'reviewer_ambiguous',
        ${`review:${reviewOne}`}, 'reviewing', 'reconcile_reviewer_start',
        ${reviewOne}::uuid, null, now())`
    await seedAdditionalDispatch(database.sql, {
      dispatchId: "67000000-0000-4000-8000-000000000020",
      deliveryId: "67000000-0000-4000-8000-000000000021", rejected: true })
    let current = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid`
    assert.equal(current[0]?.lifecycle_state, "ambiguous")

    await seedAdditionalDispatch(database.sql, {
      dispatchId: "67000000-0000-4000-8000-000000000022",
      deliveryId: "67000000-0000-4000-8000-000000000023", rejected: false })
    await database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${reviewCapabilityOne}::uuid, 'reviewer_ambiguous',
        ${`review:${reviewOne}`}, 'reviewing', 'reconcile_reviewer_start',
        ${reviewOne}::uuid, null, now())`
    current = await database.sql<Array<Record<string, unknown>>>`
      select lifecycle_state from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid`
    assert.equal(current[0]?.lifecycle_state, "ambiguous")
  })

test("a mapping cutover preserves guidance for work in the former repository",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)
    await database.sql`
      update momi_agent_ops.dispatches
      set mapped_repository = 'thedoughmonster/legacy-symphony'
      where dispatch_id = ${dispatchId}::uuid`
    await database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${capability}::uuid, 'run_ambiguous',
        'legacy-mapping', 'working', 'recover_dispatch', null, null, now())`
    await seedAdditionalDispatch(database.sql, {
      dispatchId: "67000000-0000-4000-8000-000000000032",
      deliveryId: "67000000-0000-4000-8000-000000000033", rejected: false })
    const incidents = await database.sql<Array<Record<string, unknown>>>`
      select repository, lifecycle_state from momi_agent_ops.operator_incidents`
    assert.deepEqual(incidents.map((row) => ({ ...row })), [{
      repository: "thedoughmonster/legacy-symphony", lifecycle_state: "ambiguous",
    }])
  })

async function seedImplementation(sql: Sql) {
  await sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"0".repeat(64)}, 'verified')`
  await sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      linear_project_id, linear_project_name,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values (${dispatchId}::uuid, ${deliveryId}::uuid, 'operator-incident-fixture',
      ${issueId}::uuid, 'MOX-267',
      'https://linear.app/moxx-workboard/issue/MOX-267/operator-incident',
      ${"execute-run"}, '{}'::jsonb, ${repository}, 'main', array['In Progress'],
      'active', ${projectId}::uuid, 'Symphony Control Plane', ${"1".repeat(64)},
      encode(extensions.digest(convert_to(
        ${capability}::uuid::text, 'UTF8'), 'sha256'), 'hex'),
      'implementation-thread', 'implementation-turn')`
  await sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, pull_request_number, head_sha, validation_state, validation_sha
    ) values (${dispatchId}::uuid, 17, ${head}, 'succeeded', ${head})`
}

async function seedAdditionalDispatch(sql: Sql, input: {
  dispatchId: string; deliveryId: string; rejected: boolean
  issueId?: string; identifier?: string
}) {
  await sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${input.deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"0".repeat(64)}, 'verified')`
  await sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      linear_project_id, linear_project_name, mapped_repository, mapped_base_branch,
      active_states, work_status, rejection_code, capability_token_hash
    ) values (${input.dispatchId}::uuid, ${input.deliveryId}::uuid,
      ${`additional:${input.dispatchId}`}, ${input.issueId ?? issueId}::uuid,
      ${input.identifier ?? "MOX-267"},
      ${`https://linear.app/moxx-workboard/issue/${input.identifier ?? "MOX-267"}/operator-incident`},
      ${"execute-run"}, '{}'::jsonb, ${projectId}::uuid, 'Symphony Control Plane',
      ${input.rejected ? null : repository}, ${input.rejected ? null : "main"},
      array['In Progress'], 'pending', ${input.rejected ? "unknown_project" : null},
      ${"3".repeat(64)})`
  await sql`insert into momi_agent_ops.run_records (dispatch_id)
    values (${input.dispatchId}::uuid)`
}

async function seedReview(sql: Parameters<typeof seedImplementation>[0],
  reviewAttemptId: string, reviewerDispatchId: string) {
  await sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      reviewer_callback_capability_hash, repository, pull_request_number,
      head_sha, base_sha, policy_version, profile
    ) values (${reviewAttemptId}::uuid, ${dispatchId}::uuid,
      ${reviewerDispatchId}::uuid,
      encode(extensions.digest(convert_to(
        ${reviewAttemptId === reviewOne ? reviewCapabilityOne : reviewCapabilityTwo}::uuid::text,
        'UTF8'), 'sha256'), 'hex'),
      ${repository}, 17, ${head}, ${base},
      'independent-review-v1', 'high')`
}
