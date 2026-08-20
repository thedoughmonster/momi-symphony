import assert from "node:assert/strict"
import test from "node:test"

import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

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
        select momi_agent_ops.record_review_check_v1(
          ${currentDispatchId}::uuid, ${currentReviewAttemptId}::uuid, ${newHead},
          'Symphony Independent Review', 'success') as recorded
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
    select momi_agent_ops.record_review_check_v1(
      ${currentDispatchId}::uuid, ${currentReviewAttemptId}::uuid, ${newHead},
      'Symphony Independent Review', 'success') as recorded`
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
      array['In Progress'], 'active', ${"9".repeat(64)}, ${"a".repeat(64)},
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
    assert.equal(exhausted.disposition, "escalation_exhausted")
    assert.equal(exhausted.profile, "high")
  }
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

test("parent cancellation retires ambiguous review capacity without acceptance", async (context) => {
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
  const head = "9".repeat(40)
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
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id,
      cancellation_state, target_dispatch_id
    ) values
      (${dispatchId}::uuid, ${deliveryId}::uuid, 'cancel-ambiguous-parent',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/cancel-ambiguous-parent',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active', ${"4".repeat(64)},
        encode(extensions.digest(convert_to(${callback}, 'UTF8'), 'sha256'), 'hex'),
        'implementation-thread', 'implementation-turn', 'not_requested', null),
      (${cancelDispatchId}::uuid, ${cancelDeliveryId}::uuid, 'cancel-ambiguous-request',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/cancel-ambiguous-request',
        'cancel-run', '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'claimed',
        encode(extensions.digest(convert_to(${cancelCapability}, 'UTF8'), 'sha256'), 'hex'),
        null, null, null, 'requested', ${dispatchId}::uuid),
      (${capacityDispatchId}::uuid, ${capacityDeliveryId}::uuid, 'capacity-after-cancel',
        ${capacityIssueId}::uuid, 'MOX-999',
        'https://linear.app/moxx-workboard/issue/MOX-999/capacity-after-cancel',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
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
  await database.sql`select momi_agent_ops.record_review_start_ambiguous_v1(
    ${created.reviewer_dispatch_id}::uuid, ${created.reviewer_capability_token}::uuid)`
  const [fenced] = await database.sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid) as fenced`
  assert.equal(fenced.fenced, true)
  const [recorded] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_cancellation_v3(
      ${cancelDispatchId}::uuid, ${cancelCapability}::uuid, 'requested') as recorded`
  assert.equal(recorded.recorded, true)
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
  const [replacement] = await database.sql<{ disposition: string }[]>`
    select disposition from momi_agent_ops.create_review_attempt_v1(
      ${capacityDispatchId}::uuid, ${capacityCallback}::uuid, 'capacity-thread', 'capacity-turn',
      'thedoughmonster/momi-symphony', 'main', 99, ${head}, ${baseSha}, 'high',
      'independent-review-v1', 'fnv1a64:3333333333333333',
      'review://MOX-999/capacity-after-cancel', 'fnv1a64:4444444444444444',
      array['general'], array['general'], null, 1)`
  assert.equal(replacement.disposition, "created")
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
      'independent-review-v1', 'running', ${"6".repeat(64)},
      'interrupt-thread', 'interrupt-turn', 'fnv1a64:4444444444444444',
      'review://MOX-260/interrupted', 'fnv1a64:5555555555555555',
      array['public_contract'], array['public_contract'])
  `

  expectNoIdentity(await requestResult(null, 4), "reviewer_interruption_pending")
  await database.sql`update momi_agent_ops.review_attempts
    set interruption_confirmed_at = now()
    where review_attempt_id = ${interruptAttemptId}::uuid`

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
