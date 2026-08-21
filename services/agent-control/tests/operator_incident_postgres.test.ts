import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

const dispatchId = "67000000-0000-4000-8000-000000000001"
const issueId = "67000000-0000-4000-8000-000000000002"
const deliveryId = "67000000-0000-4000-8000-000000000003"
const capability = "67000000-0000-4000-8000-000000000004"
const reviewOne = "67000000-0000-4000-8000-000000000005"
const reviewTwo = "67000000-0000-4000-8000-000000000006"
const repository = "thedoughmonster/momi-symphony"
const head = "a".repeat(40)
const base = "b".repeat(40)

test("operator incidents deduplicate exact generations, supersede new ones, and resolve once",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))
    await seedImplementation(database.sql)
    await seedReview(database.sql, reviewOne, "67000000-0000-4000-8000-000000000007")
    await seedReview(database.sql, reviewTwo, "67000000-0000-4000-8000-000000000008")

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
          ${dispatchId}::uuid, ${capability}::uuid, 'reviewer_ambiguous',
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
    assert.deepEqual(repeated, [{ lifecycle_state: "ambiguous",
      category: "reviewer_ambiguous", generation_key: `review:${reviewOne}`,
      observation_count: 2, guidance_code: "reconcile_reviewer_start",
      repository, pull_request_number: "17", head_sha: head }])

    await database.sql`
      select momi_agent_ops.record_operator_incident_v1(
        ${dispatchId}::uuid, ${capability}::uuid, 'reviewer_ambiguous',
        ${`review:${reviewTwo}`}, 'reviewing', 'reconcile_reviewer_start',
        ${reviewTwo}::uuid, null, now())`
    const generations = await database.sql<Array<Record<string, unknown>>>`
      select generation_key, lifecycle_state, resolution_code
      from momi_agent_ops.operator_incidents
      where implementation_dispatch_id = ${dispatchId}::uuid
      order by generation_key`
    assert.deepEqual(generations, [
      { generation_key: `review:${reviewOne}`, lifecycle_state: "superseded",
        resolution_code: "generation_superseded" },
      { generation_key: `review:${reviewTwo}`, lifecycle_state: "ambiguous",
        resolution_code: null },
    ])

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
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values (${dispatchId}::uuid, ${deliveryId}::uuid, 'operator-incident-fixture',
      ${issueId}::uuid, 'MOX-267',
      'https://linear.app/moxx-workboard/issue/MOX-267/operator-incident',
      ${"execute-run"}, '{}'::jsonb, ${repository}, 'main', array['In Progress'],
      'active', ${"1".repeat(64)}, encode(extensions.digest(convert_to(
        ${capability}::uuid::text, 'UTF8'), 'sha256'), 'hex'),
      'implementation-thread', 'implementation-turn')`
  await sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, pull_request_number, head_sha, validation_state, validation_sha
    ) values (${dispatchId}::uuid, 17, ${head}, 'succeeded', ${head})`
}

async function seedReview(sql: Parameters<typeof seedImplementation>[0],
  reviewAttemptId: string, reviewerDispatchId: string) {
  await sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      reviewer_callback_capability_hash, repository, pull_request_number,
      head_sha, base_sha, policy_version, profile, state, failure_reason, terminal_at
    ) values (${reviewAttemptId}::uuid, ${dispatchId}::uuid,
      ${reviewerDispatchId}::uuid, ${"2".repeat(64)}, ${repository}, 17, ${head}, ${base},
      'independent-review-v1', 'high', 'failed', 'review_host_missing', now())`
}
