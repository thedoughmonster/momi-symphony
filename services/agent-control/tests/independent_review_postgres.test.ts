import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Sql } from "postgres"

import { HostController } from "../../agent-control-host/src/host_controller.ts"
import { HostLedger } from "../../agent-control-host/src/host_ledger.ts"
import { ReviewCredentialBoundary } from "../../agent-control-host/src/review_credential_boundary.ts"
import type { AppServerClient, HostDispatch } from "../../agent-control-host/src/types.ts"
import { claimDispatch } from "../functions/momi-agent-control-dispatch-v1/src/claim_dispatch.ts"
import { recordCancellation } from "../functions/momi-agent-control-dispatch-v1/src/record_cancellation.ts"
import { recordTerminal } from "../functions/momi-agent-control-dispatch-v1/src/record_terminal.ts"
import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

class CancellationTestAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(): void { /* no notifications in cancellation fixtures */ }
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params }); return Promise.resolve({} as T)
  }
}

const currentDispatchId = "30000000-0000-4000-8000-000000000001"
const newerDispatchId = "30000000-0000-4000-8000-000000000002"
const issueId = "30000000-0000-4000-8000-000000000003"
const currentDeliveryId = "30000000-0000-4000-8000-000000000004"
const newerDeliveryId = "30000000-0000-4000-8000-000000000005"
const oldReviewAttemptId = "30000000-0000-4000-8000-000000000006"
const currentReviewAttemptId = "30000000-0000-4000-8000-000000000007"
const oldReviewerDispatchId = "30000000-0000-4000-8000-000000000008"
const currentReviewerDispatchId = "30000000-0000-4000-8000-000000000009"
const callbackToken = "30000000-0000-4000-8000-000000000010"
const oldHead = "a".repeat(40)
const newHead = "b".repeat(40)
const nextHead = "d".repeat(40)
const baseSha = "c".repeat(40)

test("head transition is CAS-bound and serialized against newer dispatch generations", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))

  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${currentDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"0".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id,
      codex_turn_id, created_at
    ) values (
      ${currentDispatchId}::uuid, ${currentDeliveryId}::uuid, 'current-generation',
      ${issueId}::uuid, 'MOX-260',
      'https://linear.app/moxx-workboard/issue/MOX-260/current',
      ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
      array['In Progress'], 'active', ${"2".repeat(64)},
      encode(extensions.digest(convert_to(${callbackToken}, 'UTF8'), 'sha256'), 'hex'),
      'implementation-thread', 'implementation-turn', now() - interval '1 minute'
    )
  `
  await database.sql`
    insert into momi_agent_ops.run_records (dispatch_id)
    values (${currentDispatchId}::uuid)
  `
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, runtime_role,
      reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${oldReviewAttemptId}::uuid, ${currentDispatchId}::uuid,
      ${oldReviewerDispatchId}::uuid, 1, 'thedoughmonster/momi-symphony', 'main', 16,
      ${oldHead}, ${baseSha}, 'high', 'gpt-5.6-sol', 'high',
      'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'accepted',
      'independent_reviewer', ${"4".repeat(64)}, 'old-reviewer-thread',
      'old-reviewer-turn', 'fnv1a64:1111111111111111',
      'review://MOX-260/old-head', 'fnv1a64:2222222222222222',
      array['security'], array['security']
    )
  `
  await database.sql`
    update momi_agent_ops.run_records set
      branch_name = 'mox-260-independent-pr-review', pull_request_number = 16,
      head_sha = ${oldHead}, validation_state = 'succeeded', validation_sha = ${oldHead},
      validation_workflow_run_id = 'protected-ci-old-head', review_state = 'succeeded',
      review_sha = ${oldHead}, review_base_sha = ${baseSha},
      review_policy_version = 'independent-review-v1', review_profile = 'high',
      review_receipt_id = ${oldReviewAttemptId}::uuid, review_check_sha = ${oldHead}
    where dispatch_id = ${currentDispatchId}::uuid
  `

  const [forward] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_lifecycle_evidence_v3(
      ${currentDispatchId}::uuid, ${callbackToken}::uuid,
      'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main',
      'mox-260-independent-pr-review', 16, 'validating', 'running',
      ${oldHead}, ${newHead}, null, 'protected-ci-new-head'
    ) as recorded
  `
  assert.equal(forward.recorded, true)
  const [forwardState] = await database.sql<{
    head_sha: string; validation_state: string; validation_sha: string
    review_state: string; review_sha: string | null; review_receipt_id: string | null
    old_review_state: string
  }[]>`
    select run.head_sha, run.validation_state, run.validation_sha,
      run.review_state, run.review_sha, run.review_receipt_id::text,
      review.state as old_review_state
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${oldReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(forwardState, { head_sha: newHead, validation_state: "running",
    validation_sha: newHead, review_state: "not_required", review_sha: null,
    review_receipt_id: null, old_review_state: "stale" })

  const [beforeReplay] = await database.sql<{ run: unknown; review: unknown }[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${oldReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  const [replay] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_lifecycle_evidence_v3(
      ${currentDispatchId}::uuid, ${callbackToken}::uuid,
      'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main',
      'mox-260-independent-pr-review', 16, 'validating', 'succeeded',
      null, ${oldHead}, null, 'delayed-old-head-callback'
    ) as recorded
  `
  assert.equal(replay.recorded, false)
  const [afterReplay] = await database.sql<typeof beforeReplay[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${oldReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(afterReplay, beforeReplay)

  for (const [branch, pullRequest] of [
    ["different-branch", 16], ["mox-260-independent-pr-review", 17],
  ] as const) {
    const [identityMismatch] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_lifecycle_evidence_v3(
        ${currentDispatchId}::uuid, ${callbackToken}::uuid,
        'implementation-thread', 'implementation-turn',
        'thedoughmonster/momi-symphony', 'main', ${branch}, ${pullRequest},
        'validating', 'running', ${newHead}, ${nextHead}, null,
        'identity-mismatch-callback'
      ) as recorded
    `
    assert.equal(identityMismatch.recorded, false)
  }
  const [afterIdentityMismatch] = await database.sql<typeof beforeReplay[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${oldReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(afterIdentityMismatch, beforeReplay)

  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, runtime_role,
      reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${currentReviewAttemptId}::uuid, ${currentDispatchId}::uuid,
      ${currentReviewerDispatchId}::uuid, 2, 'thedoughmonster/momi-symphony', 'main', 16,
      ${newHead}, ${baseSha}, 'high', 'gpt-5.6-sol', 'high',
      'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'accepted',
      'independent_reviewer', ${"5".repeat(64)}, 'current-reviewer-thread',
      'current-reviewer-turn', 'fnv1a64:3333333333333333',
      'review://MOX-260/current-head', 'fnv1a64:4444444444444444',
      array['security'], array['security']
    )
  `
  await database.sql`
    update momi_agent_ops.run_records set validation_state = 'succeeded',
      review_state = 'succeeded', review_sha = ${newHead}, review_base_sha = ${baseSha},
      review_policy_version = 'independent-review-v1', review_profile = 'high',
      review_receipt_id = ${currentReviewAttemptId}::uuid, review_check_sha = ${newHead}
    where dispatch_id = ${currentDispatchId}::uuid
  `
  const startAttemptId = "30000000-0000-4000-8000-000000000011"
  const startReviewerId = "30000000-0000-4000-8000-000000000012"
  const startToken = "30000000-0000-4000-8000-000000000013"
  const resultAttemptId = "30000000-0000-4000-8000-000000000014"
  const resultReviewerId = "30000000-0000-4000-8000-000000000015"
  const resultToken = "30000000-0000-4000-8000-000000000016"
  const escalationAttemptId = "30000000-0000-4000-8000-000000000017"
  const escalationReviewerId = "30000000-0000-4000-8000-000000000018"
  const escalationToken = "30000000-0000-4000-8000-000000000019"
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, runtime_role, result, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${startAttemptId}::uuid, ${currentDispatchId}::uuid, ${startReviewerId}::uuid, 3,
      'thedoughmonster/momi-symphony', 'main', 16, ${newHead}, ${baseSha},
      'high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'canceled', null, null,
      encode(extensions.digest(convert_to(${startToken}, 'UTF8'), 'sha256'), 'hex'),
      null, null, 'fnv1a64:7777777777777777', 'review://MOX-260/start-race',
      'fnv1a64:8888888888888888', array['concurrency'], array['concurrency']
    ), (
      ${resultAttemptId}::uuid, ${currentDispatchId}::uuid, ${resultReviewerId}::uuid, 4,
      'thedoughmonster/momi-symphony', 'main', 16, ${newHead}, ${baseSha},
      'high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'running', 'independent_reviewer', null,
      encode(extensions.digest(convert_to(${resultToken}, 'UTF8'), 'sha256'), 'hex'),
      'result-race-thread', 'result-race-turn', 'fnv1a64:9999999999999999',
      'review://MOX-260/result-race', 'fnv1a64:aaaaaaaaaaaaaaaa',
      array['concurrency'], array['concurrency']
    ), (
      ${escalationAttemptId}::uuid, ${currentDispatchId}::uuid,
      ${escalationReviewerId}::uuid, 5, 'thedoughmonster/momi-symphony', 'main', 16,
      ${newHead}, ${baseSha}, 'low', 'gpt-5.6-luna', 'low',
      'fnv1a64:9ede9fa30f041ad1', 'independent-review-v1', 'escalated',
      'independent_reviewer', 'escalate',
      encode(extensions.digest(convert_to(${escalationToken}, 'UTF8'), 'sha256'), 'hex'),
      'escalation-race-thread', 'escalation-race-turn', 'fnv1a64:bbbbbbbbbbbbbbbb',
      'review://MOX-260/escalation-race', 'fnv1a64:cccccccccccccccc',
      array['concurrency'], array['concurrency']
    )
  `
  const [beforeRace] = await database.sql<{ run: unknown; review: unknown }[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${currentReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `

  let releaseNewer!: () => void
  let reportInserted!: () => void
  let requestWaitProbe!: () => void
  let reportAdvisoryWait!: (value: boolean) => void
  const release = new Promise<void>((resolve) => { releaseNewer = resolve })
  const inserted = new Promise<void>((resolve) => { reportInserted = resolve })
  const waitProbeRequested = new Promise<void>((resolve) => { requestWaitProbe = resolve })
  const advisoryWait = new Promise<boolean>((resolve) => { reportAdvisoryWait = resolve })
  const newerGeneration = database.sql.begin(async (sql) => {
    await sql`
      insert into momi_agent_ops.raw_webhook_envelopes (
        delivery_id, raw_body, payload, payload_sha256, auth_result
      ) values (${newerDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"1".repeat(64)}, 'verified')
    `
    await sql`
      insert into momi_agent_ops.dispatches (
        dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
        linear_issue_identifier, linear_issue_url, action, changed_fields,
        mapped_repository, mapped_base_branch, active_states, work_status,
        capability_token_hash, host_callback_token_hash, codex_thread_id,
        codex_turn_id, created_at
      ) values (
        ${newerDispatchId}::uuid, ${newerDeliveryId}::uuid, 'newer-generation',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/newer',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"6".repeat(64)}, ${"7".repeat(64)},
        'newer-implementation-thread', 'newer-implementation-turn', now()
      )
    `
    await sql`insert into momi_agent_ops.run_records (dispatch_id)
      values (${newerDispatchId}::uuid)`
    reportInserted()
    await waitProbeRequested
    const deadline = Date.now() + 2_000
    let observed = false
    while (!observed && Date.now() < deadline) {
      const [waiting] = await sql<{ waiting: boolean }[]>`
        select exists (
          select 1 from pg_catalog.pg_locks
          where locktype = 'advisory' and not granted
        ) as waiting
      `
      observed = waiting.waiting
      if (!observed) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    reportAdvisoryWait(observed)
    await release
  })
  await inserted
  const racedAuthorities = Promise.all([
    (async () => {
      const [result] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_lifecycle_evidence_v3(
        ${currentDispatchId}::uuid, ${callbackToken}::uuid,
        'implementation-thread', 'implementation-turn',
        'thedoughmonster/momi-symphony', 'main',
        'mox-260-independent-pr-review', 16, 'validating', 'running',
        ${newHead}, ${nextHead}, null, 'raced-new-head-callback'
      ) as recorded
      `
      return ["lifecycle", result.recorded] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ disposition: string }[]>`
        select disposition from momi_agent_ops.create_review_attempt_v1(
          ${currentDispatchId}::uuid, ${callbackToken}::uuid,
          'implementation-thread', 'implementation-turn',
          'thedoughmonster/momi-symphony', 'main', 16, ${newHead}, ${baseSha},
          'high', 'independent-review-v1', 'fnv1a64:dddddddddddddddd',
          'review://MOX-260/create-race', 'fnv1a64:eeeeeeeeeeeeeeee',
          array['concurrency'], array['concurrency'], null, 4)
      `
      return ["create", result.disposition] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ disposition: string }[]>`
        select disposition from momi_agent_ops.create_escalated_review_attempt_v1(
          ${escalationReviewerId}::uuid, ${escalationToken}::uuid,
          'escalation-race-thread', 'escalation-race-turn',
          'fnv1a64:ffffffffffffffff', 'review://MOX-260/escalated-create-race',
          'fnv1a64:1212121212121212', array['concurrency'], 4)
      `
      return ["escalation", result.disposition] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ recorded: boolean }[]>`
        select momi_agent_ops.record_reviewer_start_v1(
          ${startReviewerId}::uuid, ${startToken}::uuid, 'independent_reviewer',
          'start-race-thread', 'start-race-turn') as recorded
      `
      return ["start", result.recorded] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ recorded: boolean }[]>`
        select momi_agent_ops.record_review_result_v1(
          ${resultReviewerId}::uuid, ${resultToken}::uuid, 'independent_reviewer',
          'result-race-thread', 'result-race-turn', 'thedoughmonster/momi-symphony', 16,
          ${newHead}, ${baseSha}, 4, 'high', 'gpt-5.6-sol', 'high',
          'fnv1a64:0b9ef0157af3f30a', 'independent-review-v1', 'inconclusive',
          '[]'::jsonb, ${`sha256:${"3".repeat(64)}`}, 'review://MOX-260/result-race',
          '{}'::jsonb) as recorded
      `
      return ["result", result.recorded] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ recorded: boolean }[]>`
        select momi_agent_ops.begin_review_check_publication_v1(
          ${currentDispatchId}::uuid, ${currentReviewAttemptId}::uuid,
          ${newHead}) is not null as recorded
      `
      return ["check", result.recorded] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ eligible: boolean }[]>`
        select momi_agent_ops.merge_review_eligible_v1(
          ${currentDispatchId}::uuid, 'thedoughmonster/momi-symphony', 'main', 16,
          ${newHead}, ${baseSha}, 'independent-review-v1', 'high') as eligible
      `
      return ["eligible", result.eligible] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ recorded: boolean }[]>`
        select momi_agent_ops.record_merge_preflight_v1(
          ${currentDispatchId}::uuid, ${callbackToken}::uuid,
          'implementation-thread', 'implementation-turn',
          'thedoughmonster/momi-symphony', 'main', 16, ${newHead}, ${baseSha},
          'independent-review-v1', 'high') as recorded
      `
      return ["preflight", result.recorded] as const
    })(),
    (async () => {
      const [result] = await database.sql<{ count: number }[]>`
        select count(*)::integer as count from momi_agent_ops.record_terminal_v5(
          ${currentDispatchId}::uuid, ${callbackToken}::uuid,
          'implementation-thread', 'implementation-turn', 'ready', 'completed',
          'obsolete concurrent terminal', now(), '{}'::jsonb)
      `
      return ["terminal", result.count] as const
    })(),
  ])
  requestWaitProbe()
  const advisoryWaitObserved = await advisoryWait
  releaseNewer()
  await newerGeneration
  assert.equal(advisoryWaitObserved, true)
  assert.deepEqual(Object.fromEntries(await racedAuthorities), {
    lifecycle: false, create: "current_generation_refused",
    escalation: "escalation_identity_refused", start: false, result: true,
    check: false, eligible: false, preflight: false, terminal: 0,
  })

  const [afterRace] = await database.sql<typeof beforeRace[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${currentReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(afterRace, beforeRace)

  await database.sql`update momi_agent_ops.run_records set review_check_sha = null,
    merge_preflight_sha = null, merge_preflight_base_sha = null,
    merge_preflight_review_receipt_id = null, merge_preflight_at = null
    where dispatch_id = ${currentDispatchId}::uuid`
  const [beforeOldAuthority] = await database.sql<{
    run: unknown; review: unknown; attempt_count: number
  }[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review,
      (select count(*)::integer from momi_agent_ops.review_attempts attempt
        where attempt.implementation_dispatch_id = ${currentDispatchId}::uuid) as attempt_count
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${currentReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  const [reuse] = await database.sql<{
    disposition: string; review_attempt_id: string | null;
    reviewer_dispatch_id: string | null; generation: number | null
  }[]>`
    select disposition, review_attempt_id::text, reviewer_dispatch_id::text, generation
    from momi_agent_ops.create_review_attempt_v1(
      ${currentDispatchId}::uuid, ${callbackToken}::uuid,
      'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main', 16, ${newHead}, ${baseSha},
      'high', 'independent-review-v1', 'fnv1a64:5555555555555555',
      'review://MOX-260/current-generation-refused', 'fnv1a64:6666666666666666',
      array['concurrency'], array['concurrency'], null, 4)
  `
  assert.deepEqual(reuse, { disposition: "current_generation_refused",
    review_attempt_id: null, reviewer_dispatch_id: null, generation: null })
  const [eligible] = await database.sql<{ eligible: boolean }[]>`
    select momi_agent_ops.merge_review_eligible_v1(
      ${currentDispatchId}::uuid, 'thedoughmonster/momi-symphony', 'main', 16,
      ${newHead}, ${baseSha}, 'independent-review-v1', 'high') as eligible`
  assert.equal(eligible.eligible, false)
  const [projected] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.begin_review_check_publication_v1(
      ${currentDispatchId}::uuid, ${currentReviewAttemptId}::uuid,
      ${newHead}) is not null as recorded`
  assert.equal(projected.recorded, false)
  const [preflight] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_merge_preflight_v1(
      ${currentDispatchId}::uuid, ${callbackToken}::uuid,
      'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main', 16, ${newHead}, ${baseSha},
      'independent-review-v1', 'high') as recorded`
  assert.equal(preflight.recorded, false)
  const [terminal] = await database.sql<{ count: number }[]>`
    select count(*)::integer as count from momi_agent_ops.record_terminal_v5(
      ${currentDispatchId}::uuid, ${callbackToken}::uuid,
      'implementation-thread', 'implementation-turn', 'ready', 'completed',
      'must not complete an obsolete generation', now(), '{}'::jsonb)`
  assert.equal(terminal.count, 0)
  const [afterOldAuthority] = await database.sql<typeof beforeOldAuthority[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review,
      (select count(*)::integer from momi_agent_ops.review_attempts attempt
        where attempt.implementation_dispatch_id = ${currentDispatchId}::uuid) as attempt_count
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${currentReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(afterOldAuthority, beforeOldAuthority)
})

test("review escalation promotes low to standard to high and then exhausts", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const deliveryId = "31000000-0000-4000-8000-000000000001"
  const dispatchId = "31000000-0000-4000-8000-000000000002"
  const escalationIssueId = "31000000-0000-4000-8000-000000000003"
  const sourceAttemptId = "31000000-0000-4000-8000-000000000004"
  const sourceReviewerId = "31000000-0000-4000-8000-000000000005"
  const sourceToken = "31000000-0000-4000-8000-000000000006"
  const implementationCallback = "31000000-0000-4000-8000-000000000007"
  const escalationHead = "e".repeat(40)
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"8".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values (
      ${dispatchId}::uuid, ${deliveryId}::uuid, 'escalation-generation',
      ${escalationIssueId}::uuid, 'MOX-260',
      'https://linear.app/moxx-workboard/issue/MOX-260/escalation',
      ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
      array['In Progress'], 'active', ${"9".repeat(64)},
      encode(extensions.digest(convert_to(${implementationCallback}, 'UTF8'), 'sha256'), 'hex'),
      'implementation-thread', 'implementation-turn'
    )
  `
  await database.sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, head_sha, validation_state, validation_sha, review_state,
      review_sha, review_base_sha, review_policy_version, review_profile
    ) values (
      ${dispatchId}::uuid, ${escalationHead}, 'succeeded', ${escalationHead}, 'running',
      ${escalationHead}, ${baseSha}, 'independent-review-v1', 'low'
    )
  `
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, runtime_role,
      reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions, started_at
    ) values (
      ${sourceAttemptId}::uuid, ${dispatchId}::uuid, ${sourceReviewerId}::uuid, 1,
      'thedoughmonster/momi-symphony', 'main', 16, ${escalationHead}, ${baseSha},
      'low', 'gpt-5.6-luna', 'low', 'fnv1a64:9ede9fa30f041ad1',
      'independent-review-v1', 'running',
      'independent_reviewer',
      encode(extensions.digest(convert_to(${sourceToken}, 'UTF8'), 'sha256'), 'hex'),
      'low-thread', 'low-turn', 'fnv1a64:1111111111111111',
      'review://MOX-260/low', 'fnv1a64:2222222222222222',
      array['general'], array['general'], now()
    )
  `

  let reviewerId = sourceReviewerId
  let reviewerToken = sourceToken
  let reviewerThread = "low-thread"
  let reviewerTurn = "low-turn"
  let profile = "low"
  let reviewModel = "gpt-5.6-luna"
  let reasoningEffort = "low"
  let budgetFingerprint = "fnv1a64:9ede9fa30f041ad1"
  for (const expectedProfile of ["standard", "high"] as const) {
    await assert.rejects(database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_review_result_v1(
        ${reviewerId}::uuid, ${reviewerToken}::uuid, 'independent_reviewer',
        ${reviewerThread}, ${reviewerTurn}, 'thedoughmonster/momi-symphony', 16,
        ${escalationHead}, ${baseSha}, ${profile === "low" ? 1 : 2}, ${profile},
        ${reviewModel}, ${reasoningEffort}, 'fnv1a64:ffffffffffffffff',
        'independent-review-v1', 'escalate', '[]'::jsonb,
        ${`sha256:${"0".repeat(64)}`}, 'review://MOX-260/budget-mismatch', '{}'::jsonb
      ) as recorded
    `, /review_result_invalid/)
    const [recorded] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_review_result_v1(
        ${reviewerId}::uuid, ${reviewerToken}::uuid, 'independent_reviewer',
        ${reviewerThread}, ${reviewerTurn}, 'thedoughmonster/momi-symphony', 16,
        ${escalationHead}, ${baseSha}, ${profile === "low" ? 1 : 2}, ${profile},
        ${reviewModel}, ${reasoningEffort}, ${budgetFingerprint},
        'independent-review-v1', 'escalate', '[]'::jsonb,
        ${`sha256:${profile === "low" ? "1" : "2"}`.padEnd(71, profile === "low" ? "1" : "2")},
        ${`review://MOX-260/${profile}-escalate`}, '{}'::jsonb
      ) as recorded
    `
    assert.equal(recorded.recorded, true)
    const [promoted] = await database.sql<{
      disposition: string; reviewer_dispatch_id: string; reviewer_capability_token: string;
      generation: number; profile: string
    }[]>`
      select disposition, reviewer_dispatch_id::text, reviewer_capability_token::text,
        generation, profile from momi_agent_ops.create_escalated_review_attempt_v1(
          ${reviewerId}::uuid, ${reviewerToken}::uuid, ${reviewerThread}, ${reviewerTurn},
          ${`fnv1a64:${expectedProfile === "standard" ? "3" : "4"}`.padEnd(24,
            expectedProfile === "standard" ? "3" : "4")},
          ${`review://MOX-260/${expectedProfile}`},
          ${`fnv1a64:${expectedProfile === "standard" ? "5" : "6"}`.padEnd(24,
            expectedProfile === "standard" ? "5" : "6")}, array['general'], 4
        )
    `
    assert.equal(promoted.disposition, "created")
    assert.equal(promoted.profile, expectedProfile)
    assert.equal(promoted.generation, expectedProfile === "standard" ? 2 : 3)
    reviewerId = promoted.reviewer_dispatch_id
    reviewerToken = promoted.reviewer_capability_token
    reviewerThread = `${expectedProfile}-thread`
    reviewerTurn = `${expectedProfile}-turn`
    profile = expectedProfile
    reviewModel = expectedProfile === "standard" ? "gpt-5.6-terra" : "gpt-5.6-sol"
    reasoningEffort = expectedProfile === "standard" ? "medium" : "high"
    budgetFingerprint = expectedProfile === "standard"
      ? "fnv1a64:9631b8b9d5daf636" : "fnv1a64:0b9ef0157af3f30a"
    const [started] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_reviewer_start_v1(
        ${reviewerId}::uuid, ${reviewerToken}::uuid, 'independent_reviewer',
        ${reviewerThread}, ${reviewerTurn}) as recorded
    `
    assert.equal(started.recorded, true)
  }

  const [highRecorded] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_result_v1(
      ${reviewerId}::uuid, ${reviewerToken}::uuid, 'independent_reviewer',
      ${reviewerThread}, ${reviewerTurn}, 'thedoughmonster/momi-symphony', 16,
      ${escalationHead}, ${baseSha}, 3, 'high', 'gpt-5.6-sol', 'high',
      'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'escalate',
      '[]'::jsonb, ${`sha256:${"7".repeat(64)}`}, 'review://MOX-260/high-escalate',
      '{}'::jsonb) as recorded
  `
  assert.equal(highRecorded.recorded, true)
  for (let replay = 0; replay < 2; replay += 1) {
    const [exhausted] = await database.sql<{ disposition: string; profile: string }[]>`
      select disposition, profile from momi_agent_ops.create_escalated_review_attempt_v1(
        ${reviewerId}::uuid, ${reviewerToken}::uuid, ${reviewerThread}, ${reviewerTurn},
        'fnv1a64:8888888888888888', 'review://MOX-260/exhausted',
        'fnv1a64:9999999999999999', array['general'], 4)
    `
    assert.equal(exhausted.disposition, "review_budget_exhausted")
    assert.equal(exhausted.profile, "high")
  }
  const [ordinaryReplay] = await database.sql<{ disposition: string }[]>`
    select disposition from momi_agent_ops.create_review_attempt_v1(
      ${dispatchId}::uuid, ${implementationCallback}::uuid,
      'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main', 16, ${escalationHead}, ${baseSha},
      'high', 'independent-review-v1', 'fnv1a64:aaaaaaaaaaaaaaaa',
      'review://MOX-260/exhausted-ordinary', 'fnv1a64:bbbbbbbbbbbbbbbb',
      array['general'], array['general'], null, 4)
  `
  assert.equal(ordinaryReplay.disposition, "review_budget_exhausted")
  const [state] = await database.sql<{
    review_state: string; attempt_count: number; profiles: string[]; models: string[];
    efforts: string[]; budget_fingerprints: string[]; states: string[]
  }[]>`
    select run.review_state, count(attempt.*)::integer as attempt_count,
      array_agg(attempt.profile order by attempt.generation) as profiles,
      array_agg(attempt.review_model order by attempt.generation) as models,
      array_agg(attempt.reasoning_effort order by attempt.generation) as efforts,
      array_agg(attempt.budget_fingerprint order by attempt.generation) as budget_fingerprints,
      array_agg(attempt.state order by attempt.generation) as states
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts attempt
      on attempt.implementation_dispatch_id = run.dispatch_id
    where run.dispatch_id = ${dispatchId}::uuid group by run.review_state
  `
  assert.deepEqual(state, { review_state: "failed", attempt_count: 3,
    profiles: ["low", "standard", "high"],
    models: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    efforts: ["low", "medium", "high"], budget_fingerprints: [
      "fnv1a64:9ede9fa30f041ad1", "fnv1a64:9631b8b9d5daf636",
      "fnv1a64:0b9ef0157af3f30a"],
    states: ["escalated", "escalated", "failed"] })
})

test("ambiguous reviewer response loss blocks replacement until terminal reconciliation",
async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const deliveryId = "31500000-0000-4000-8000-000000000001"
  const dispatchId = "31500000-0000-4000-8000-000000000002"
  const ambiguousIssueId = "31500000-0000-4000-8000-000000000003"
  const callback = "31500000-0000-4000-8000-000000000004"
  const head = "f".repeat(40)
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"d".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values (
      ${dispatchId}::uuid, ${deliveryId}::uuid, 'ambiguous-review-response-loss',
      ${ambiguousIssueId}::uuid, 'MOX-260',
      'https://linear.app/moxx-workboard/issue/MOX-260/ambiguous-review-response-loss',
      ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
      array['In Progress'], 'active', ${"e".repeat(64)},
      encode(extensions.digest(convert_to(${callback}, 'UTF8'), 'sha256'), 'hex'),
      'implementation-thread', 'implementation-turn')
  `
  await database.sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, head_sha, validation_state, validation_sha
    ) values (${dispatchId}::uuid, ${head}, 'succeeded', ${head})
  `
  const create = async (packet: string) => {
    const [result] = await database.sql<{
      disposition: string; review_attempt_id: string; reviewer_dispatch_id: string;
      reviewer_capability_token: string | null; generation: number
    }[]>`
      select disposition, review_attempt_id::text, reviewer_dispatch_id::text,
        reviewer_capability_token::text, generation
      from momi_agent_ops.create_review_attempt_v1(
        ${dispatchId}::uuid, ${callback}::uuid, 'implementation-thread',
        'implementation-turn', 'thedoughmonster/momi-symphony', 'main', 16,
        ${head}, ${baseSha}, 'high', 'independent-review-v1', ${packet},
        'review://MOX-260/ambiguous-response-loss', 'fnv1a64:2222222222222222',
        array['scheduler_recovery_cancellation'],
        array['scheduler_recovery_cancellation'], null, 4)
    `
    return result
  }
  const created = await create('fnv1a64:1111111111111111')
  assert.equal(created.disposition, "created")
  assert.ok(created.reviewer_capability_token)
  const [ambiguous] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_start_ambiguous_v1(
      ${created.reviewer_dispatch_id}::uuid,
      ${created.reviewer_capability_token}::uuid) as recorded
  `
  assert.equal(ambiguous.recorded, true)

  const blocked = await create('fnv1a64:3333333333333333')
  assert.deepEqual(blocked, { disposition: "already_ambiguous",
    review_attempt_id: created.review_attempt_id,
    reviewer_dispatch_id: created.reviewer_dispatch_id,
    reviewer_capability_token: null, generation: 1 })
  const [blockedState] = await database.sql<{
    attempt_count: number; state: string; terminal_at: string | null
  }[]>`
    select count(*) over ()::integer as attempt_count, state, terminal_at::text
    from momi_agent_ops.review_attempts
    where implementation_dispatch_id = ${dispatchId}::uuid
  `
  assert.deepEqual(blockedState, { attempt_count: 1, state: "ambiguous", terminal_at: null })

  const [reconciled] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_result_v1(
      ${created.reviewer_dispatch_id}::uuid, ${created.reviewer_capability_token}::uuid,
      'independent_reviewer', 'recovered-review-thread', 'recovered-review-turn',
      'thedoughmonster/momi-symphony', 16, ${head}, ${baseSha}, 1, 'high',
      'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'inconclusive', '[]'::jsonb,
      ${`sha256:${"4".repeat(64)}`}, 'review://MOX-260/reconciled-response-loss',
      '{}'::jsonb) as recorded
  `
  assert.equal(reconciled.recorded, true)
  const [terminal] = await database.sql<{
    state: string; result: string; reviewer_thread_id: string;
    reviewer_turn_id: string; terminal: boolean; interruption_confirmed: boolean
  }[]>`
    select state, result, reviewer_thread_id, reviewer_turn_id,
      terminal_at is not null as terminal,
      interruption_confirmed_at is not null as interruption_confirmed
    from momi_agent_ops.review_attempts
    where review_attempt_id = ${created.review_attempt_id}::uuid
  `
  assert.deepEqual(terminal, { state: "failed", result: "inconclusive",
    reviewer_thread_id: "recovered-review-thread", reviewer_turn_id: "recovered-review-turn",
    terminal: true, interruption_confirmed: true })

  const replacement = await create('fnv1a64:5555555555555555')
  assert.equal(replacement.disposition, "created")
  assert.equal(replacement.generation, 2)
  assert.notEqual(replacement.reviewer_dispatch_id, created.reviewer_dispatch_id)
})

test("parent cancellation retires reserved review capacity across receipt replay", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const deliveryId = "31600000-0000-4000-8000-000000000001"
  const dispatchId = "31600000-0000-4000-8000-000000000002"
  const issueId = "31600000-0000-4000-8000-000000000003"
  const callback = "31600000-0000-4000-8000-000000000004"
  const cancelDeliveryId = "31600000-0000-4000-8000-000000000005"
  const cancelDispatchId = "31600000-0000-4000-8000-000000000006"
  const cancelCapability = "31600000-0000-4000-8000-000000000007"
  const capacityDeliveryId = "31600000-0000-4000-8000-000000000008"
  const capacityDispatchId = "31600000-0000-4000-8000-000000000009"
  const capacityIssueId = "31600000-0000-4000-8000-000000000010"
  const capacityCallback = "31600000-0000-4000-8000-000000000011"
  const projectId = "31600000-0000-4000-8000-000000000012"
  const head = "9".repeat(40)
  await database.sql`
    insert into momi_agent_ops.project_mappings (
      linear_project_id, linear_project_name, repository, base_branch,
      active_states, active, host_dispatch_url
    ) values (${projectId}::uuid, 'Symphony Control Plane',
      'thedoughmonster/momi-symphony', 'main', array['In Progress'], true,
      'https://host.example/v1/dispatch')`
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values
      (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb, ${"1".repeat(64)}, 'verified'),
      (${cancelDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"2".repeat(64)}, 'verified'),
      (${capacityDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"3".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, linear_project_id,
      linear_project_name, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id,
      cancellation_state, target_dispatch_id
    ) values
      (${dispatchId}::uuid, ${deliveryId}::uuid, 'cancel-ambiguous-parent',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/cancel-ambiguous-parent',
        ${projectId}::uuid, 'Symphony Control Plane', ${"execute-run"}, '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"4".repeat(64)},
        encode(extensions.digest(convert_to(${callback}, 'UTF8'), 'sha256'), 'hex'),
        'implementation-thread', 'implementation-turn', 'not_requested', null),
      (${cancelDispatchId}::uuid, ${cancelDeliveryId}::uuid, 'cancel-ambiguous-request',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/cancel-ambiguous-request',
        ${projectId}::uuid, 'Symphony Control Plane', 'cancel-run', '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'claimed',
        encode(extensions.digest(convert_to(${cancelCapability}, 'UTF8'), 'sha256'), 'hex'),
        null, null, null, 'requested', ${dispatchId}::uuid),
      (${capacityDispatchId}::uuid, ${capacityDeliveryId}::uuid, 'capacity-after-cancel',
        ${capacityIssueId}::uuid, 'MOX-999',
        'https://linear.app/moxx-workboard/issue/MOX-999/capacity-after-cancel',
        ${projectId}::uuid, 'Symphony Control Plane', ${"execute-run"}, '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"5".repeat(64)},
        encode(extensions.digest(convert_to(${capacityCallback}, 'UTF8'), 'sha256'), 'hex'),
        'capacity-thread', 'capacity-turn', 'not_requested', null)
  `
  await database.sql`
    insert into momi_agent_ops.run_records (dispatch_id, head_sha, validation_state, validation_sha)
    values (${dispatchId}::uuid, ${head}, 'succeeded', ${head}),
      (${capacityDispatchId}::uuid, ${head}, 'succeeded', ${head})
  `
  await database.sql`insert into momi_agent_ops.run_records (dispatch_id)
    values (${cancelDispatchId}::uuid)`
  const [created] = await database.sql<{
    review_attempt_id: string; reviewer_dispatch_id: string; reviewer_capability_token: string
  }[]>`
    select review_attempt_id::text, reviewer_dispatch_id::text,
      reviewer_capability_token::text from momi_agent_ops.create_review_attempt_v1(
      ${dispatchId}::uuid, ${callback}::uuid, 'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main', 16, ${head}, ${baseSha}, 'high',
      'independent-review-v1', 'fnv1a64:1111111111111111',
      'review://MOX-260/cancel-ambiguous', 'fnv1a64:2222222222222222',
      array['scheduler_recovery_cancellation'], array['scheduler_recovery_cancellation'], null, 1)
  `
  const completeTargets = [dispatchId, created.reviewer_dispatch_id].sort()
  const [initialTargets] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)::text[] as target_ids`
  assert.deepEqual(initialTargets.target_ids, completeTargets)
  const revocations = await database.sql<{
    implementation_dispatch_id: string; head_sha: string;
    publication_pending: boolean; revocation_required: boolean
  }[]>`
    select implementation_dispatch_id::text, head_sha,
      publication_pending, revocation_required
    from momi_agent_ops.prepare_review_check_revocations_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)`
  assert.deepEqual([...revocations], [{ implementation_dispatch_id: dispatchId, head_sha: head,
    publication_pending: false, revocation_required: true }])
  const [revoked] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_check_revocation_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid,
      ${dispatchId}::uuid, ${head}) as recorded`
  assert.equal(revoked.recorded, true)
  const [fenced] = await database.sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid) as fenced`
  assert.equal(fenced.fenced, true)
  const [fencedTargets] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)::text[] as target_ids`
  assert.deepEqual(fencedTargets.target_ids, completeTargets)
  const terminal = await recordTerminal({ event: "terminal", work_id: dispatchId,
    capability_token: callback, thread_id: "implementation-thread",
    turn_id: "implementation-turn", readiness_result: "ready",
    terminal_disposition: "interrupted", archived_at: "2026-08-21T02:00:00.000Z",
    summary: "Cancellation terminalized before reviewer receipt persistence.",
    telemetry: { policy_version: "execution-efficiency.v1",
      stable_prefix_fingerprint: "cancel-replay-stable-prefix",
      context_fingerprint: "cancel-replay-context", input_tokens: 1,
      cached_input_tokens: 0, output_tokens: 1, model_visible_tool_bytes: 1,
      model_turns: 1, no_progress_cycles: 0, subagents: 0, max_subagent_depth: 0,
      retries: 0, repeated_failure_fingerprints: 0, elapsed_ms: 1,
      disposition: "interrupted" } }, database.sql)
  assert.equal(terminal?.issue_identifier, "MOX-260")
  await database.sql`update momi_agent_ops.dispatches set
    lease_expires_at = now() - interval '1 second'
    where dispatch_id = ${cancelDispatchId}::uuid`
  const [transientRetry] = await database.sql<{
    delivery_phase: string; cancellation_state: string; cancellation_target_ids: string[]
  }[]>`
    select delivery_phase, cancellation_state, cancellation_target_ids::text[]
    from momi_agent_ops.claim_dispatch_v6(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)`
  assert.deepEqual(transientRetry, { delivery_phase: "writeback",
    cancellation_state: "already_terminal", cancellation_target_ids: [] })
  const [reconstructedRetry] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)::text[] as target_ids`
  assert.deepEqual(reconstructedRetry.target_ids, completeTargets)
  const [blockedParent] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_cancellation_v3(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid, 'requested') as recorded`
  assert.equal(blockedParent.recorded, false)
  const [forgedReceipt] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${created.reviewer_dispatch_id}::uuid,
      '31600000-0000-4000-8000-000000000099'::uuid,
      'reserved', 'canceled', true, true) as recorded`
  assert.equal(forgedReceipt.recorded, false)
  const [receipt] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${created.reviewer_dispatch_id}::uuid,
      ${created.reviewer_capability_token}::uuid,
      'reserved', 'canceled', false, false) as recorded`
  assert.equal(receipt.recorded, true)
  const [afterReceipt] = await database.sql<{
    state: string; active_reviews: number; interruption_confirmed: boolean;
    cancellation_receipt_fingerprint: string
  }[]>`
    select attempt.state,
      (select count(*)::integer from momi_agent_ops.review_attempts active
        where active.state in ('reserved', 'running', 'ambiguous')) as active_reviews,
      attempt.interruption_confirmed_at is not null as interruption_confirmed,
      attempt.cancellation_receipt_fingerprint
    from momi_agent_ops.review_attempts attempt
    where attempt.review_attempt_id = ${created.review_attempt_id}::uuid`
  assert.deepEqual(
    { state: afterReceipt.state, active_reviews: afterReceipt.active_reviews,
      interruption_confirmed: afterReceipt.interruption_confirmed },
    { state: "canceled", active_reviews: 0, interruption_confirmed: false })
  assert.match(afterReceipt.cancellation_receipt_fingerprint, /^sha256:[0-9a-f]{64}$/)
  const [enrichedReceipt] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${created.reviewer_dispatch_id}::uuid,
      ${created.reviewer_capability_token}::uuid,
      'canceled', 'canceled', true, true) as recorded`
  assert.equal(enrichedReceipt.recorded, true)
  const [afterEnrichment] = await database.sql<{
    interruption_confirmed: boolean; cancellation_receipt_fingerprint: string
  }[]>`
    select attempt.interruption_confirmed_at is not null as interruption_confirmed,
      attempt.cancellation_receipt_fingerprint
    from momi_agent_ops.review_attempts attempt
    where attempt.review_attempt_id = ${created.review_attempt_id}::uuid`
  assert.equal(afterEnrichment.interruption_confirmed, true)
  assert.notEqual(afterEnrichment.cancellation_receipt_fingerprint,
    afterReceipt.cancellation_receipt_fingerprint)
  const [replayedReceipt] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${created.reviewer_dispatch_id}::uuid,
      ${created.reviewer_capability_token}::uuid,
      'canceled', 'canceled', true, true) as recorded`
  assert.equal(replayedReceipt.recorded, true)
  const [downgradedReceipt] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${created.reviewer_dispatch_id}::uuid,
      ${created.reviewer_capability_token}::uuid,
      'canceled', 'canceled', false, false) as recorded`
  assert.equal(downgradedReceipt.recorded, false)
  const [receiptCrashReplay] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)::text[] as target_ids`
  assert.deepEqual(receiptCrashReplay.target_ids, completeTargets)
  const [recorded] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_cancellation_v3(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid, 'requested') as recorded`
  assert.equal(recorded.recorded, true)
  const [attemptCount] = await database.sql<{ count: number }[]>`
    select count(*)::integer as count from momi_agent_ops.review_attempts
    where implementation_dispatch_id = ${dispatchId}::uuid`
  assert.equal(attemptCount.count, 1)
  const [lateResult] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_result_v1(
      ${created.reviewer_dispatch_id}::uuid, ${created.reviewer_capability_token}::uuid,
      'independent_reviewer', 'late-thread', 'late-turn',
      'thedoughmonster/momi-symphony', 16, ${head}, ${baseSha}, 1, 'high',
      'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'accepted', '[]'::jsonb,
      ${`sha256:${"6".repeat(64)}`}, 'review://MOX-260/late-after-cancel',
      '{}'::jsonb) as recorded`
  assert.equal(lateResult.recorded, false)
  const [state] = await database.sql<{
    attempt_state: string; active_reviews: number; review_state: string;
    review_receipt_id: string | null; review_check_sha: string | null;
    merge_preflight_sha: string | null
  }[]>`
    select attempt.state as attempt_state,
      (select count(*)::integer from momi_agent_ops.review_attempts active
        where active.state in ('reserved', 'running', 'ambiguous')) as active_reviews,
      run.review_state, run.review_receipt_id::text, run.review_check_sha,
      run.merge_preflight_sha
    from momi_agent_ops.review_attempts attempt
    join momi_agent_ops.run_records run on run.dispatch_id = attempt.implementation_dispatch_id
    where attempt.review_attempt_id = ${created.review_attempt_id}::uuid
  `
  assert.deepEqual(state, { attempt_state: "canceled", active_reviews: 0,
    review_state: "failed", review_receipt_id: null, review_check_sha: null,
    merge_preflight_sha: null })
  const [replacement] = await database.sql<{ disposition: string;
    reviewer_dispatch_id: string; reviewer_capability_token: string }[]>`
    select disposition, reviewer_dispatch_id::text, reviewer_capability_token::text
    from momi_agent_ops.create_review_attempt_v1(
      ${capacityDispatchId}::uuid, ${capacityCallback}::uuid, 'capacity-thread', 'capacity-turn',
      'thedoughmonster/momi-symphony', 'main', 99, ${head}, ${baseSha}, 'high',
      'independent-review-v1', 'fnv1a64:3333333333333333',
      'review://MOX-999/capacity-after-cancel', 'fnv1a64:4444444444444444',
      array['general'], array['general'], null, 1)`
  assert.equal(replacement.disposition, "created")
  await database.sql`select momi_agent_ops.record_review_start_ambiguous_v1(
    ${replacement.reviewer_dispatch_id}::uuid,
    ${replacement.reviewer_capability_token}::uuid)`
  const [ambiguousReceipt] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${replacement.reviewer_dispatch_id}::uuid,
      ${replacement.reviewer_capability_token}::uuid,
      'ambiguous', 'canceled', false, false) as recorded`
  assert.equal(ambiguousReceipt.recorded, true)
})

test("parent cancellation retires a DB-only reviewer reservation through the real host path",
async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const directory = await mkdtemp(join(tmpdir(), "momi-review-db-only-cancel-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const deliveryId = "31700000-0000-4000-8000-000000000001"
  const dispatchId = "31700000-0000-4000-8000-000000000002"
  const issueId = "31700000-0000-4000-8000-000000000003"
  const callback = "31700000-0000-4000-8000-000000000004"
  const cancelDeliveryId = "31700000-0000-4000-8000-000000000005"
  const cancelDispatchId = "31700000-0000-4000-8000-000000000006"
  const cancelCapability = "31700000-0000-4000-8000-000000000007"
  const capacityDeliveryId = "31700000-0000-4000-8000-000000000008"
  const capacityDispatchId = "31700000-0000-4000-8000-000000000009"
  const capacityIssueId = "31700000-0000-4000-8000-000000000010"
  const capacityCallback = "31700000-0000-4000-8000-000000000011"
  const projectId = "31700000-0000-4000-8000-000000000012"
  const head = "7".repeat(40)
  await database.sql`
    insert into momi_agent_ops.project_mappings (
      linear_project_id, linear_project_name, repository, base_branch,
      active_states, active, host_dispatch_url
    ) values (${projectId}::uuid, 'Symphony Control Plane',
      'thedoughmonster/momi-symphony', 'main', array['In Progress'], true,
      'https://host.example/v1/dispatch')`
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values
      (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb, ${"1".repeat(64)}, 'verified'),
      (${cancelDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"2".repeat(64)}, 'verified'),
      (${capacityDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"3".repeat(64)}, 'verified')`
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, linear_project_id,
      linear_project_name, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id,
      cancellation_state, target_dispatch_id, lease_expires_at
    ) values
      (${dispatchId}::uuid, ${deliveryId}::uuid, 'db-only-review-parent',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/db-only-review-parent',
        ${projectId}::uuid, 'Symphony Control Plane', ${"execute-run"}, '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'active',
        ${"4".repeat(64)},
        encode(extensions.digest(convert_to(${callback}, 'UTF8'), 'sha256'), 'hex'),
        'implementation-thread', 'implementation-turn', 'not_requested', null, null),
      (${cancelDispatchId}::uuid, ${cancelDeliveryId}::uuid, 'db-only-review-cancel',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/db-only-review-cancel',
        ${projectId}::uuid, 'Symphony Control Plane', 'cancel-run', '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'claimed',
        encode(extensions.digest(convert_to(${cancelCapability}, 'UTF8'), 'sha256'), 'hex'),
        null, null, null, 'requested', ${dispatchId}::uuid, now() - interval '1 second'),
      (${capacityDispatchId}::uuid, ${capacityDeliveryId}::uuid, 'db-only-review-capacity',
        ${capacityIssueId}::uuid, 'MOX-998',
        'https://linear.app/moxx-workboard/issue/MOX-998/db-only-review-capacity',
        ${projectId}::uuid, 'Symphony Control Plane', ${"execute-run"}, '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'active',
        ${"5".repeat(64)},
        encode(extensions.digest(convert_to(${capacityCallback}, 'UTF8'), 'sha256'), 'hex'),
        'capacity-thread', 'capacity-turn', 'not_requested', null, null)`
  await database.sql`
    insert into momi_agent_ops.run_records (dispatch_id, head_sha, validation_state, validation_sha)
    values (${dispatchId}::uuid, ${head}, 'succeeded', ${head}),
      (${capacityDispatchId}::uuid, ${head}, 'succeeded', ${head})`
  await database.sql`insert into momi_agent_ops.run_records (dispatch_id)
    values (${cancelDispatchId}::uuid)`
  const [created] = await database.sql<{
    review_attempt_id: string; reviewer_dispatch_id: string; reviewer_capability_token: string
  }[]>`
    select review_attempt_id::text, reviewer_dispatch_id::text,
      reviewer_capability_token::text from momi_agent_ops.create_review_attempt_v1(
      ${dispatchId}::uuid, ${callback}::uuid, 'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main', 16, ${head}, ${baseSha}, 'high',
      'independent-review-v1', 'fnv1a64:1111111111111111',
      'review://MOX-260/db-only-reservation', 'fnv1a64:2222222222222222',
      array['scheduler_recovery_cancellation'], array['scheduler_recovery_cancellation'], null, 1)`

  const implementationClient = new CancellationTestAppServer()
  const reviewClient = new CancellationTestAppServer()
  const ledger = new HostLedger(join(directory, "ledger.json"),
    new ReviewCredentialBoundary(Buffer.alloc(32, 23)))
  const controller = new HostController(implementationClient, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => Promise.resolve(), reviewClient)
  await controller.start()
  await ledger.reserve(dispatchId, "implementation-fingerprint", "implementation-token")
  await ledger.accept(dispatchId, "implementation-thread", "implementation-turn")
  const cancelInput = { work_id: cancelDispatchId, capability_token: cancelCapability }
  const github = { publishReviewCheck: () => Promise.resolve() }
  const firstClaim = await claimDispatch(cancelInput, database.sql, github as never)
  assert.deepEqual(firstClaim?.cancellation_target_ids,
    [dispatchId, created.reviewer_dispatch_id].sort())
  const hostInput = { schema_version: 2 as const, work_id: cancelDispatchId,
    capability_token: cancelCapability,
    target_work_ids: firstClaim!.cancellation_target_ids,
    repository: "thedoughmonster/momi-symphony", base_branch: "main" }
  const firstHostResult = await controller.cancel(hostInput)
  assert.deepEqual(firstHostResult.review_cancellations, [])
  assert.deepEqual(firstHostResult.unmaterialized_reviewer_dispatch_ids,
    [created.reviewer_dispatch_id])

  await database.sql`update momi_agent_ops.dispatches set
    lease_expires_at = now() - interval '1 second'
    where dispatch_id = ${cancelDispatchId}::uuid`
  const replayClaim = await claimDispatch(cancelInput, database.sql, github as never)
  assert.deepEqual(replayClaim?.cancellation_target_ids,
    firstClaim?.cancellation_target_ids)
  const replayHostResult = await controller.cancel(hostInput)
  assert.deepEqual(replayHostResult, firstHostResult)
  const [proofBeforeCrash] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_unmaterialized_review_cancellation_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid,
      ${created.reviewer_dispatch_id}::uuid) as recorded`
  assert.equal(proofBeforeCrash.recorded, true)
  assert.equal(await recordCancellation(cancelInput, replayHostResult, database.sql), true)
  assert.equal(await recordCancellation(cancelInput, replayHostResult, database.sql), true)

  const lateDispatch: HostDispatch = { schema_version: 4,
    work_id: created.reviewer_dispatch_id,
    capability_token: created.reviewer_capability_token,
    issue_id: issueId, issue_identifier: "MOX-260",
    issue_url: "https://linear.app/moxx-workboard/issue/MOX-260/db-only-review-parent",
    project_id: projectId, project_name: "Symphony Control Plane",
    repository: "thedoughmonster/momi-symphony", base_branch: "main",
    active_states: ["In Progress"], interaction_mode: "one_shot",
    thread_name: "MOX-260 · independent review", runtime_role: "independent_reviewer",
    review_workspace_id: "31700000-0000-4000-8000-000000000013",
    stable_instruction: "review", volatile_context: "bounded",
    stable_prefix_fingerprint: "fnv1a64:3333333333333333",
    context_fingerprint: "fnv1a64:4444444444444444",
    policy_version: "independent-review-v1",
    budget: { model_turns: 16, no_progress_cycles: 2, subagents: 0,
      subagent_depth: 0, model_visible_tool_bytes: 96_000, elapsed_ms: 3_600_000 },
    review_subject: { implementation_dispatch_id: dispatchId, pull_request_number: 16,
      head_sha: head, base_sha: baseSha, generation: 1, profile: "high",
      model: "gpt-5.6-sol", reasoning_effort: "high",
      budget_fingerprint: "fnv1a64:0b9ef0157af3f30a",
      policy_version: "independent-review-v1" } }
  await assert.rejects(controller.dispatch(lateDispatch), /host_dispatch_canceled/)
  assert.equal(reviewClient.requests.some((request) => request.method === "thread/start"), false)
  const [lateStart] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_reviewer_start_v1(
      ${created.reviewer_dispatch_id}::uuid, ${created.reviewer_capability_token}::uuid,
      'independent_reviewer', 'late-thread', 'late-turn') as recorded`
  assert.equal(lateStart.recorded, false)
  const [lateResult] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_result_v1(
      ${created.reviewer_dispatch_id}::uuid, ${created.reviewer_capability_token}::uuid,
      'independent_reviewer', 'late-thread', 'late-turn',
      'thedoughmonster/momi-symphony', 16, ${head}, ${baseSha}, 1, 'high',
      'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'accepted', '[]'::jsonb,
      ${`sha256:${"7".repeat(64)}`}, 'review://MOX-260/db-only-late-result',
      '{}'::jsonb) as recorded`
  assert.equal(lateResult.recorded, false)
  const [state] = await database.sql<{
    state: string; active_reviews: number; attempts: number; cancellation_state: string;
    cancellation_work_status: string;
    host_unmaterialized: boolean; reviewer_thread_id: string | null;
    reviewer_turn_id: string | null
  }[]>`
    select review.state, review.host_unmaterialized_at is not null as host_unmaterialized,
      review.reviewer_thread_id, review.reviewer_turn_id,
      (select count(*)::integer from momi_agent_ops.review_attempts active
        where active.state in ('reserved', 'running', 'ambiguous')) as active_reviews,
      (select count(*)::integer from momi_agent_ops.review_attempts attempts
        where attempts.implementation_dispatch_id = ${dispatchId}::uuid) as attempts,
      cancel.cancellation_state, cancel.work_status as cancellation_work_status
    from momi_agent_ops.review_attempts review
    join momi_agent_ops.dispatches cancel on cancel.dispatch_id = ${cancelDispatchId}::uuid
    where review.review_attempt_id = ${created.review_attempt_id}::uuid`
  assert.deepEqual(state, { state: "canceled", host_unmaterialized: true,
    reviewer_thread_id: null, reviewer_turn_id: null, active_reviews: 0, attempts: 1,
    cancellation_state: "requested", cancellation_work_status: "writeback_pending" })
  const [replacement] = await database.sql<{ disposition: string }[]>`
    select disposition from momi_agent_ops.create_review_attempt_v1(
      ${capacityDispatchId}::uuid, ${capacityCallback}::uuid, 'capacity-thread', 'capacity-turn',
      'thedoughmonster/momi-symphony', 'main', 98, ${head}, ${baseSha}, 'high',
      'independent-review-v1', 'fnv1a64:5555555555555555',
      'review://MOX-998/capacity-after-db-only-cancel', 'fnv1a64:6666666666666666',
      array['general'], array['general'], null, 1)`
  assert.equal(replacement.disposition, "created")
})

test("initial and escalated reviewers atomically compete for the final capacity slot",
async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const initialDeliveryId = "31900000-0000-4000-8000-000000000001"
  const initialDispatchId = "31900000-0000-4000-8000-000000000002"
  const initialIssueId = "31900000-0000-4000-8000-000000000003"
  const initialCallback = "31900000-0000-4000-8000-000000000004"
  const escalationDeliveryId = "31900000-0000-4000-8000-000000000005"
  const escalationDispatchId = "31900000-0000-4000-8000-000000000006"
  const escalationIssueId = "31900000-0000-4000-8000-000000000007"
  const sourceAttemptId = "31900000-0000-4000-8000-000000000008"
  const sourceReviewerId = "31900000-0000-4000-8000-000000000009"
  const sourceCapability = "31900000-0000-4000-8000-000000000010"
  const head = "6".repeat(40)
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values
      (${initialDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"8".repeat(64)}, 'verified'),
      (${escalationDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"9".repeat(64)}, 'verified')`
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values
      (${initialDispatchId}::uuid, ${initialDeliveryId}::uuid, 'capacity-race-initial',
        ${initialIssueId}::uuid, 'MOX-970',
        'https://linear.app/moxx-workboard/issue/MOX-970/capacity-race-initial',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"a".repeat(64)},
        encode(extensions.digest(convert_to(${initialCallback}, 'UTF8'), 'sha256'), 'hex'),
        'capacity-initial-thread', 'capacity-initial-turn'),
      (${escalationDispatchId}::uuid, ${escalationDeliveryId}::uuid,
        'capacity-race-escalation', ${escalationIssueId}::uuid, 'MOX-971',
        'https://linear.app/moxx-workboard/issue/MOX-971/capacity-race-escalation',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"b".repeat(64)}, ${"c".repeat(64)},
        'capacity-escalation-implementation-thread',
        'capacity-escalation-implementation-turn')`
  await database.sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, head_sha, validation_state, validation_sha
    ) values (${initialDispatchId}::uuid, ${head}, 'succeeded', ${head}),
      (${escalationDispatchId}::uuid, ${head}, 'succeeded', ${head})`
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, subject_attempt_number, repository, base_branch, pull_request_number,
      head_sha, base_sha, profile, review_model, reasoning_effort, budget_fingerprint,
      policy_version, state, result, runtime_role, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${sourceAttemptId}::uuid, ${escalationDispatchId}::uuid,
      ${sourceReviewerId}::uuid, 1, 1, 'thedoughmonster/momi-symphony', 'main', 17,
      ${head}, ${baseSha}, 'low', 'gpt-5.6-luna', 'low',
      'fnv1a64:9ede9fa30f041ad1', 'independent-review-v1', 'escalated', 'escalate',
      'independent_reviewer',
      encode(extensions.digest(convert_to(${sourceCapability}, 'UTF8'), 'sha256'), 'hex'),
      'capacity-escalation-review-thread', 'capacity-escalation-review-turn',
      'fnv1a64:1111111111111111', 'review://MOX-971/capacity-source',
      'fnv1a64:2222222222222222', array['concurrency'], array['concurrency'])`

  let reportHeld!: () => void; let releaseHolder!: () => void
  const held = new Promise<void>((resolve) => { reportHeld = resolve })
  const release = new Promise<void>((resolve) => { releaseHolder = resolve })
  const holder = database.sql.begin(async (sql) => {
    await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'momi_agent_ops.review_capacity', 0))`
    reportHeld(); await release
  })
  await held
  const initial = (async () => {
    const [result] = await database.sql<{ disposition: string }[]>`
      select disposition from momi_agent_ops.create_review_attempt_v1(
        ${initialDispatchId}::uuid, ${initialCallback}::uuid,
        'capacity-initial-thread', 'capacity-initial-turn',
        'thedoughmonster/momi-symphony', 'main', 16, ${head}, ${baseSha}, 'high',
        'independent-review-v1', 'fnv1a64:3333333333333333',
        'review://MOX-970/capacity-race', 'fnv1a64:4444444444444444',
        array['concurrency'], array['concurrency'], null, 1)`
    return result.disposition
  })()
  const escalated = (async () => {
    const [result] = await database.sql<{ disposition: string }[]>`
      select disposition from momi_agent_ops.create_escalated_review_attempt_v1(
        ${sourceReviewerId}::uuid, ${sourceCapability}::uuid,
        'capacity-escalation-review-thread', 'capacity-escalation-review-turn',
        'fnv1a64:5555555555555555', 'review://MOX-971/capacity-race',
        'fnv1a64:6666666666666666', array['concurrency'], 1)`
    return result.disposition
  })()
  const deadline = Date.now() + 2_000
  let waiters = 0
  try {
    while (waiters < 2 && Date.now() < deadline) {
      const [waiting] = await database.sql<{ count: number }[]>`
        select count(*)::integer as count from pg_catalog.pg_locks
        where locktype = 'advisory' and not granted`
      waiters = waiting.count
      if (waiters < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(waiters, 2)
  } finally {
    releaseHolder()
  }
  assert.deepEqual((await Promise.all([initial, escalated])).sort(),
    ["capacity_wait", "created"])
  await holder
  const [active] = await database.sql<{ count: number }[]>`
    select count(*)::integer as count from momi_agent_ops.review_attempts
    where state in ('reserved', 'running', 'ambiguous')`
  assert.equal(active.count, 1)
})

test("cancellation and escalation serialize without escaping the exact target set",
async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const projectId = "32100000-0000-4000-8000-000000000001"
  const cancelFirstDispatchId = "32100000-0000-4000-8000-000000000002"
  const cancelFirstIssueId = "32100000-0000-4000-8000-000000000003"
  const cancelFirstDeliveryId = "32100000-0000-4000-8000-000000000004"
  const cancelFirstSourceId = "32100000-0000-4000-8000-000000000005"
  const cancelFirstReviewerId = "32100000-0000-4000-8000-000000000006"
  const cancelFirstReviewerCapability = "32100000-0000-4000-8000-000000000007"
  const cancelFirstCancelDeliveryId = "32100000-0000-4000-8000-000000000008"
  const cancelFirstCancelId = "32100000-0000-4000-8000-000000000009"
  const cancelFirstCapability = "32100000-0000-4000-8000-000000000010"
  const escalationFirstDispatchId = "32100000-0000-4000-8000-000000000011"
  const escalationFirstIssueId = "32100000-0000-4000-8000-000000000012"
  const escalationFirstDeliveryId = "32100000-0000-4000-8000-000000000013"
  const escalationFirstSourceId = "32100000-0000-4000-8000-000000000014"
  const escalationFirstReviewerId = "32100000-0000-4000-8000-000000000015"
  const escalationFirstReviewerCapability = "32100000-0000-4000-8000-000000000016"
  const escalationFirstCancelDeliveryId = "32100000-0000-4000-8000-000000000017"
  const escalationFirstCancelId = "32100000-0000-4000-8000-000000000018"
  const escalationFirstCapability = "32100000-0000-4000-8000-000000000019"
  const head = "9".repeat(40)
  await database.sql`
    insert into momi_agent_ops.project_mappings (
      linear_project_id, linear_project_name, repository, base_branch,
      active_states, active, host_dispatch_url
    ) values (${projectId}::uuid, 'Symphony Control Plane',
      'thedoughmonster/momi-symphony', 'main', array['In Progress'], true,
      'https://host.example/v1/dispatch')`
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values
      (${cancelFirstDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"1".repeat(64)}, 'verified'),
      (${cancelFirstCancelDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"2".repeat(64)}, 'verified'),
      (${escalationFirstDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"3".repeat(64)}, 'verified'),
      (${escalationFirstCancelDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"4".repeat(64)}, 'verified')`
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, linear_project_id,
      linear_project_name, action, changed_fields, mapped_repository,
      mapped_base_branch, active_states, work_status, capability_token_hash,
      codex_thread_id, codex_turn_id, cancellation_state, target_dispatch_id
    ) values
      (${cancelFirstDispatchId}::uuid, ${cancelFirstDeliveryId}::uuid,
        'cancel-first-escalation-parent', ${cancelFirstIssueId}::uuid, 'MOX-972',
        'https://linear.app/moxx-workboard/issue/MOX-972/cancel-first-escalation-parent',
        ${projectId}::uuid, 'Symphony Control Plane', ${"execute-run"}, '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'active',
        ${"5".repeat(64)}, 'cancel-first-thread', 'cancel-first-turn',
        'not_requested', null),
      (${cancelFirstCancelId}::uuid, ${cancelFirstCancelDeliveryId}::uuid,
        'cancel-first-escalation-cancel', ${cancelFirstIssueId}::uuid, 'MOX-972',
        'https://linear.app/moxx-workboard/issue/MOX-972/cancel-first-escalation-cancel',
        ${projectId}::uuid, 'Symphony Control Plane', 'cancel-run', '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'claimed',
        encode(extensions.digest(convert_to(${cancelFirstCapability}, 'UTF8'), 'sha256'), 'hex'),
        null, null, 'requested', ${cancelFirstDispatchId}::uuid),
      (${escalationFirstDispatchId}::uuid, ${escalationFirstDeliveryId}::uuid,
        'escalation-first-parent', ${escalationFirstIssueId}::uuid, 'MOX-973',
        'https://linear.app/moxx-workboard/issue/MOX-973/escalation-first-parent',
        ${projectId}::uuid, 'Symphony Control Plane', ${"execute-run"}, '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'active',
        ${"6".repeat(64)}, 'escalation-first-thread', 'escalation-first-turn',
        'not_requested', null),
      (${escalationFirstCancelId}::uuid, ${escalationFirstCancelDeliveryId}::uuid,
        'escalation-first-cancel', ${escalationFirstIssueId}::uuid, 'MOX-973',
        'https://linear.app/moxx-workboard/issue/MOX-973/escalation-first-cancel',
        ${projectId}::uuid, 'Symphony Control Plane', 'cancel-run', '{}'::jsonb,
        'thedoughmonster/momi-symphony', 'main', array['In Progress'], 'claimed',
        encode(extensions.digest(convert_to(${escalationFirstCapability}, 'UTF8'), 'sha256'), 'hex'),
        null, null, 'requested', ${escalationFirstDispatchId}::uuid)`
  await database.sql`
    insert into momi_agent_ops.run_records (dispatch_id) values
      (${cancelFirstDispatchId}::uuid), (${cancelFirstCancelId}::uuid),
      (${escalationFirstDispatchId}::uuid), (${escalationFirstCancelId}::uuid)`
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, result, runtime_role, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values
      (${cancelFirstSourceId}::uuid, ${cancelFirstDispatchId}::uuid,
        ${cancelFirstReviewerId}::uuid, 1, 'thedoughmonster/momi-symphony', 'main', 16,
        ${head}, ${baseSha}, 'low', 'gpt-5.6-luna', 'low',
        'fnv1a64:9ede9fa30f041ad1', 'independent-review-v1', 'escalated', 'escalate',
        'independent_reviewer', encode(extensions.digest(convert_to(
          ${cancelFirstReviewerCapability}, 'UTF8'), 'sha256'), 'hex'),
        'cancel-first-review-thread', 'cancel-first-review-turn',
        'fnv1a64:1111111111111111', 'review://MOX-972/cancel-first-source',
        'fnv1a64:2222222222222222', array['concurrency'], array['concurrency']),
      (${escalationFirstSourceId}::uuid, ${escalationFirstDispatchId}::uuid,
        ${escalationFirstReviewerId}::uuid, 1, 'thedoughmonster/momi-symphony', 'main', 17,
        ${head}, ${baseSha}, 'low', 'gpt-5.6-luna', 'low',
        'fnv1a64:9ede9fa30f041ad1', 'independent-review-v1', 'escalated', 'escalate',
        'independent_reviewer', encode(extensions.digest(convert_to(
          ${escalationFirstReviewerCapability}, 'UTF8'), 'sha256'), 'hex'),
        'escalation-first-review-thread', 'escalation-first-review-turn',
        'fnv1a64:3333333333333333', 'review://MOX-973/escalation-first-source',
        'fnv1a64:4444444444444444', array['concurrency'], array['concurrency'])`

  let reportCancelFenced!: () => void; let releaseCancel!: () => void
  const cancelFenced = new Promise<void>((resolve) => { reportCancelFenced = resolve })
  const cancelRelease = new Promise<void>((resolve) => { releaseCancel = resolve })
  const cancelWinner = database.sql.begin(async (sql) => {
    const [fenced] = await sql<{ fenced: boolean }[]>`
      select momi_agent_ops.fence_cancellation_v1(
        ${cancelFirstCancelId}::uuid, ${cancelFirstCapability}::uuid) as fenced`
    assert.equal(fenced.fenced, true)
    reportCancelFenced(); await cancelRelease
  })
  await cancelFenced
  const refusedEscalation = (async () => await database.sql<{ disposition: string;
    reviewer_dispatch_id: string | null }[]>`
      select disposition, reviewer_dispatch_id::text
      from momi_agent_ops.create_escalated_review_attempt_v1(
        ${cancelFirstReviewerId}::uuid, ${cancelFirstReviewerCapability}::uuid,
        'cancel-first-review-thread', 'cancel-first-review-turn',
        'fnv1a64:5555555555555555', 'review://MOX-972/cancel-first-replay',
        'fnv1a64:6666666666666666', array['concurrency'], 4)`)()
  try {
    await waitForAdvisoryWaiters(database.sql, 1)
  } finally {
    releaseCancel()
  }
  const [refused] = await refusedEscalation
  await cancelWinner
  assert.equal(refused.disposition, "escalation_identity_refused")
  assert.equal(refused.reviewer_dispatch_id, null)
  const [cancelFirstState] = await database.sql<{
    attempt_count: number; child_count: number; active_count: number
  }[]>`
    select count(*)::integer as attempt_count,
      count(*) filter (where escalation_of is not null)::integer as child_count,
      count(*) filter (where state in ('reserved', 'running', 'ambiguous'))::integer
        as active_count
    from momi_agent_ops.review_attempts
    where implementation_dispatch_id = ${cancelFirstDispatchId}::uuid`
  const [cancelFirstTargets] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${cancelFirstCancelId}::uuid, ${cancelFirstCapability}::uuid)::text[] as target_ids`
  assert.deepEqual(cancelFirstState, { attempt_count: 1, child_count: 0, active_count: 0 })
  assert.deepEqual(cancelFirstTargets.target_ids, [cancelFirstDispatchId])

  let reportChildCreated!: (child: { reviewer_dispatch_id: string }) => void
  let releaseEscalation!: () => void
  const childCreated = new Promise<{ reviewer_dispatch_id: string }>((resolve) => {
    reportChildCreated = resolve
  })
  const escalationRelease = new Promise<void>((resolve) => { releaseEscalation = resolve })
  const escalationWinner = database.sql.begin(async (sql) => {
    const [child] = await sql<{ disposition: string; reviewer_dispatch_id: string }[]>`
      select disposition, reviewer_dispatch_id::text
      from momi_agent_ops.create_escalated_review_attempt_v1(
        ${escalationFirstReviewerId}::uuid, ${escalationFirstReviewerCapability}::uuid,
        'escalation-first-review-thread', 'escalation-first-review-turn',
        'fnv1a64:7777777777777777', 'review://MOX-973/escalation-first-race',
        'fnv1a64:8888888888888888', array['concurrency'], 4)`
    assert.equal(child.disposition, "created")
    reportChildCreated(child); await escalationRelease
  })
  const child = await childCreated
  const waitingCancellation = (async () => await database.sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${escalationFirstCancelId}::uuid, ${escalationFirstCapability}::uuid) as fenced`)()
  try {
    await waitForAdvisoryWaiters(database.sql, 1)
  } finally {
    releaseEscalation()
  }
  const [fencedAfterChild] = await waitingCancellation
  await escalationWinner
  assert.equal(fencedAfterChild.fenced, true)
  const [targetsBeforeRetirement] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${escalationFirstCancelId}::uuid,
      ${escalationFirstCapability}::uuid)::text[] as target_ids`
  const expectedTargets = [escalationFirstDispatchId, child.reviewer_dispatch_id].sort()
  assert.deepEqual(targetsBeforeRetirement.target_ids, expectedTargets)
  for (let replay = 0; replay < 2; replay += 1) {
    const [receipt] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_unmaterialized_review_cancellation_v1(
        ${escalationFirstCancelId}::uuid, ${escalationFirstCapability}::uuid,
        ${child.reviewer_dispatch_id}::uuid) as recorded`
    assert.equal(receipt.recorded, true)
    const [parent] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_cancellation_v3(
        ${escalationFirstCancelId}::uuid, ${escalationFirstCapability}::uuid,
        'requested') as recorded`
    assert.equal(parent.recorded, true)
  }
  const [targetsAfterRetirement] = await database.sql<{ target_ids: string[] }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${escalationFirstCancelId}::uuid,
      ${escalationFirstCapability}::uuid)::text[] as target_ids`
  assert.deepEqual(targetsAfterRetirement.target_ids, expectedTargets)
  const [replayedEscalation] = await database.sql<{ disposition: string }[]>`
    select disposition from momi_agent_ops.create_escalated_review_attempt_v1(
      ${escalationFirstReviewerId}::uuid, ${escalationFirstReviewerCapability}::uuid,
      'escalation-first-review-thread', 'escalation-first-review-turn',
      'fnv1a64:9999999999999999', 'review://MOX-973/escalation-after-cancel',
      'fnv1a64:aaaaaaaaaaaaaaaa', array['concurrency'], 4)`
  assert.equal(replayedEscalation.disposition, "escalation_identity_refused")
  const [escalationFirstState] = await database.sql<{
    attempts: number; children: number; active: number; child_state: string
  }[]>`
    select count(*)::integer as attempts,
      count(*) filter (where escalation_of is not null)::integer as children,
      count(*) filter (where state in ('reserved', 'running', 'ambiguous'))::integer as active,
      max(state) filter (where reviewer_dispatch_id = ${child.reviewer_dispatch_id}::uuid)
        as child_state
    from momi_agent_ops.review_attempts
    where implementation_dispatch_id = ${escalationFirstDispatchId}::uuid`
  assert.deepEqual(escalationFirstState,
    { attempts: 2, children: 1, active: 0, child_state: "canceled" })
})

async function waitForAdvisoryWaiters(sql: Sql,
  expected: number): Promise<void> {
  const deadline = Date.now() + 2_000
  let waiters = 0
  while (waiters < expected && Date.now() < deadline) {
    const [waiting] = await sql<{ count: number }[]>`
      select count(*)::integer as count from pg_catalog.pg_locks
      where locktype = 'advisory' and not granted`
    waiters = waiting.count
    if (waiters < expected) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(waiters, expected)
}

test("cancellation recovers an abandoned exact-head success projection before fencing",
async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const deliveryId = "31800000-0000-4000-8000-000000000001"
  const dispatchId = "31800000-0000-4000-8000-000000000002"
  const issueId = "31800000-0000-4000-8000-000000000003"
  const callback = "31800000-0000-4000-8000-000000000004"
  const attemptId = "31800000-0000-4000-8000-000000000005"
  const reviewerId = "31800000-0000-4000-8000-000000000006"
  const cancelDeliveryId = "31800000-0000-4000-8000-000000000007"
  const cancelDispatchId = "31800000-0000-4000-8000-000000000008"
  const cancelCapability = "31800000-0000-4000-8000-000000000009"
  const head = "8".repeat(40)
  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values
      (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb, ${"7".repeat(64)}, 'verified'),
      (${cancelDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"8".repeat(64)}, 'verified')`
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id,
      cancellation_state, target_dispatch_id
    ) values
      (${dispatchId}::uuid, ${deliveryId}::uuid, 'check-revocation-target',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/check-revocation-target',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"9".repeat(64)},
        encode(extensions.digest(convert_to(${callback}, 'UTF8'), 'sha256'), 'hex'),
        'implementation-thread', 'implementation-turn', 'not_requested', null),
      (${cancelDispatchId}::uuid, ${cancelDeliveryId}::uuid, 'check-revocation-cancel',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/check-revocation-cancel',
        'cancel-run', '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'claimed',
        encode(extensions.digest(convert_to(${cancelCapability}, 'UTF8'), 'sha256'), 'hex'),
        null, null, null, 'requested', ${dispatchId}::uuid)`
  await database.sql`
    insert into momi_agent_ops.run_records (dispatch_id) values (${cancelDispatchId}::uuid)`
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, runtime_role, result, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${attemptId}::uuid, ${dispatchId}::uuid, ${reviewerId}::uuid, 1,
      'thedoughmonster/momi-symphony', 'main', 16, ${head}, ${baseSha},
      'high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'accepted', 'independent_reviewer', 'accepted',
      ${"a".repeat(64)}, 'review-thread', 'review-turn', 'fnv1a64:1111111111111111',
      'review://MOX-260/check-revocation', 'fnv1a64:2222222222222222',
      array['github_release'], array['github_release'])`
  await database.sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, branch_name, pull_request_number, head_sha,
      validation_state, validation_sha, review_state, review_sha, review_base_sha,
      review_policy_version, review_profile, review_receipt_id,
      merge_preflight_sha, merge_preflight_base_sha,
      merge_preflight_review_receipt_id, merge_preflight_at
    ) values (
      ${dispatchId}::uuid, 'mox-260-independent-pr-review', 16, ${head},
      'succeeded', ${head}, 'succeeded', ${head}, ${baseSha},
      'independent-review-v1', 'high', ${attemptId}::uuid,
      ${head}, ${baseSha}, ${attemptId}::uuid, now())`
  const [publication] = await database.sql<{ token: string | null }[]>`
    select momi_agent_ops.begin_review_check_publication_v1(
      ${dispatchId}::uuid, ${attemptId}::uuid, ${head})::text as token`
  assert.ok(publication.token)
  const pending = await database.sql<{ publication_pending: boolean }[]>`
    select publication_pending from momi_agent_ops.prepare_review_check_revocations_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)`
  assert.deepEqual([...pending], [{ publication_pending: true }])
  const [activeRecovery] = await database.sql<{ recovered: boolean }[]>`
    select momi_agent_ops.recover_abandoned_review_check_publication_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid,
      ${dispatchId}::uuid, ${head}) as recovered`
  assert.equal(activeRecovery.recovered, false)
  await database.sql`update momi_agent_ops.run_records set
    review_check_publication_started_at = now() - interval '6 minutes'
    where dispatch_id = ${dispatchId}::uuid`
  const [abandonedRecovery] = await database.sql<{ recovered: boolean }[]>`
    select momi_agent_ops.recover_abandoned_review_check_publication_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid,
      ${dispatchId}::uuid, ${head}) as recovered`
  assert.equal(abandonedRecovery.recovered, true)
  const [staleFinish] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.finish_review_check_publication_v1(
      ${dispatchId}::uuid, ${attemptId}::uuid, ${head},
      ${publication.token}::uuid, true) as recorded`
  assert.equal(staleFinish.recorded, false)
  const ready = await database.sql<{ publication_pending: boolean;
    revocation_required: boolean }[]>`
    select publication_pending, revocation_required
    from momi_agent_ops.prepare_review_check_revocations_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid)`
  assert.deepEqual([...ready], [{ publication_pending: false, revocation_required: true }])
  const [revoked] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_check_revocation_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid,
      ${dispatchId}::uuid, ${head}) as recorded`
  assert.equal(revoked.recorded, true)
  const [fenced] = await database.sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid) as fenced`
  assert.equal(fenced.fenced, true)
  const [authority] = await database.sql<{
    eligible: boolean; preflight: boolean; begin_token: string | null;
    review_check_sha: string | null; canceled: boolean
  }[]>`
    select
      momi_agent_ops.merge_review_eligible_v1(
        ${dispatchId}::uuid, 'thedoughmonster/momi-symphony', 'main', 16,
        ${head}, ${baseSha}, 'independent-review-v1', 'high') as eligible,
      momi_agent_ops.record_merge_preflight_v1(
        ${dispatchId}::uuid, ${callback}::uuid,
        'implementation-thread', 'implementation-turn',
        'thedoughmonster/momi-symphony', 'main', 16,
        ${head}, ${baseSha}, 'independent-review-v1', 'high') as preflight,
      momi_agent_ops.begin_review_check_publication_v1(
        ${dispatchId}::uuid, ${attemptId}::uuid, ${head})::text as begin_token,
      run.review_check_sha, work.cancellation_requested_at is not null as canceled
    from momi_agent_ops.run_records run
    join momi_agent_ops.dispatches work on work.dispatch_id = run.dispatch_id
    where run.dispatch_id = ${dispatchId}::uuid`
  assert.deepEqual(authority, { eligible: false, preflight: false, begin_token: null,
    review_check_sha: null, canceled: true })
})

test("no-attempt review dispositions clear prior exact-subject identities", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  const deliveryId = "32000000-0000-4000-8000-000000000001"
  const dispatchId = "32000000-0000-4000-8000-000000000002"
  const refusalIssueId = "32000000-0000-4000-8000-000000000003"
  const priorAttemptId = "32000000-0000-4000-8000-000000000004"
  const priorReviewerId = "32000000-0000-4000-8000-000000000005"
  const interruptAttemptId = "32000000-0000-4000-8000-000000000006"
  const interruptReviewerId = "32000000-0000-4000-8000-000000000007"
  const capacityDeliveryId = "32000000-0000-4000-8000-000000000008"
  const capacityDispatchId = "32000000-0000-4000-8000-000000000009"
  const capacityIssueId = "32000000-0000-4000-8000-000000000010"
  const capacityAttemptId = "32000000-0000-4000-8000-000000000011"
  const capacityReviewerId = "32000000-0000-4000-8000-000000000012"
  const invalidReverificationId = "32000000-0000-4000-8000-000000000013"
  const callback = "32000000-0000-4000-8000-000000000014"
  const interruptToken = "32000000-0000-4000-8000-000000000015"
  const subjectHead = "1".repeat(40)
  const supersededHead = "2".repeat(40)
  const requestResult = async (reverificationOf: string | null, reviewLimit: number) => {
    const [result] = await database.sql<{
      disposition: string; review_attempt_id: string | null;
      reviewer_dispatch_id: string | null; reviewer_capability_token: string | null;
      generation: number | null; reviewer_thread_id: string | null
    }[]>`
      select disposition, review_attempt_id::text, reviewer_dispatch_id::text,
        reviewer_capability_token::text, generation, reviewer_thread_id
      from momi_agent_ops.create_review_attempt_v1(
        ${dispatchId}::uuid, ${callback}::uuid, 'implementation-thread',
        'implementation-turn', 'thedoughmonster/momi-symphony', 'main', 16,
        ${subjectHead}, ${baseSha}, 'high', 'independent-review-v1',
        'fnv1a64:1111111111111111', 'review://MOX-260/no-attempt',
        'fnv1a64:2222222222222222', array['public_contract'],
        array['public_contract'], ${reverificationOf}::uuid, ${reviewLimit})
    `
    return result
  }
  const expectNoIdentity = (result: Awaited<ReturnType<typeof requestResult>>,
    disposition: string) => assert.deepEqual(result, { disposition,
    review_attempt_id: null, reviewer_dispatch_id: null,
    reviewer_capability_token: null, generation: null, reviewer_thread_id: null })

  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"3".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values (
      ${dispatchId}::uuid, ${deliveryId}::uuid, 'no-attempt-dispositions',
      ${refusalIssueId}::uuid, 'MOX-260',
      'https://linear.app/moxx-workboard/issue/MOX-260/refusals',
      ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
      array['In Progress'], 'active', ${"4".repeat(64)},
      encode(extensions.digest(convert_to(${callback}, 'UTF8'), 'sha256'), 'hex'),
      'implementation-thread', 'implementation-turn')
  `
  await database.sql`
    insert into momi_agent_ops.run_records (
      dispatch_id, head_sha, validation_state, validation_sha, review_state,
      review_sha, review_base_sha, review_policy_version, review_profile
    ) values (${dispatchId}::uuid, ${subjectHead}, 'succeeded', ${subjectHead},
      'inconclusive', ${subjectHead}, ${baseSha}, 'independent-review-v1', 'high')
  `
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, reviewer_capability_token_hash, reviewer_thread_id, reviewer_turn_id,
      packet_fingerprint, packet_artifact_ref, rules_fingerprint,
      risk_dimensions, correction_risk_dimensions
    ) values (
      ${priorAttemptId}::uuid, ${dispatchId}::uuid, ${priorReviewerId}::uuid, 1,
      'thedoughmonster/momi-symphony', 'main', 16, ${subjectHead}, ${baseSha},
      'high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'inconclusive', ${"5".repeat(64)},
      'prior-terminal-thread', 'prior-terminal-turn', 'fnv1a64:3333333333333333',
      'review://MOX-260/prior-terminal', 'fnv1a64:2222222222222222',
      array['public_contract'], array['public_contract']),
    (
      ${interruptAttemptId}::uuid, ${dispatchId}::uuid, ${interruptReviewerId}::uuid, 2,
      'thedoughmonster/momi-symphony', 'main', 16, ${supersededHead}, ${baseSha},
      'high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a',
      'independent-review-v1', 'running',
      encode(extensions.digest(convert_to(${interruptToken}, 'UTF8'), 'sha256'), 'hex'),
      'interrupt-thread', 'interrupt-turn', 'fnv1a64:4444444444444444',
      'review://MOX-260/interrupted', 'fnv1a64:5555555555555555',
      array['public_contract'], array['public_contract'])
  `

  expectNoIdentity(await requestResult(null, 4), "reviewer_interruption_pending")
  const [interrupted] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_cancellation_receipt_v1(
      ${interruptReviewerId}::uuid, ${interruptToken}::uuid,
      'superseded', 'canceled', true, true) as recorded`
  assert.equal(interrupted.recorded, true)

  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values (${capacityDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
      ${"7".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
    ) values (
      ${capacityDispatchId}::uuid, ${capacityDeliveryId}::uuid, 'review-capacity-holder',
      ${capacityIssueId}::uuid, 'MOX-999', 'https://linear.app/moxx-workboard/issue/MOX-999/review-capacity-holder',
      ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
      array['In Progress'], 'active', ${"8".repeat(64)}, ${"9".repeat(64)},
      'capacity-thread', 'capacity-turn')
  `
  await database.sql`insert into momi_agent_ops.run_records (dispatch_id)
    values (${capacityDispatchId}::uuid)`
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, review_model, reasoning_effort, budget_fingerprint, policy_version,
      state, reviewer_capability_token_hash, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${capacityAttemptId}::uuid, ${capacityDispatchId}::uuid,
      ${capacityReviewerId}::uuid, 1, 'thedoughmonster/momi-symphony', 'main', 99,
      ${supersededHead}, ${baseSha}, 'high', 'gpt-5.6-sol', 'high',
      'fnv1a64:0b9ef0157af3f30a', 'independent-review-v1', 'reserved',
      ${"a".repeat(64)}, 'fnv1a64:6666666666666666', 'review://MOX-999/capacity',
      'fnv1a64:7777777777777777', array['general'], array['general'])
  `

  expectNoIdentity(await requestResult(null, 1), "capacity_wait")
  await database.sql`update momi_agent_ops.review_attempts set state = 'canceled'
    where review_attempt_id = ${capacityAttemptId}::uuid`
  expectNoIdentity(await requestResult(invalidReverificationId, 4),
    "reverification_refused")
})
