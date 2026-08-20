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
      profile, policy_version, state, runtime_role, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${oldReviewAttemptId}::uuid, ${currentDispatchId}::uuid,
      ${oldReviewerDispatchId}::uuid, 1, 'thedoughmonster/momi-symphony', 'main', 16,
      ${oldHead}, ${baseSha}, 'high', 'independent-review-v1', 'accepted',
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
      profile, policy_version, state, runtime_role, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${currentReviewAttemptId}::uuid, ${currentDispatchId}::uuid,
      ${currentReviewerDispatchId}::uuid, 2, 'thedoughmonster/momi-symphony', 'main', 16,
      ${newHead}, ${baseSha}, 'high', 'independent-review-v1', 'accepted',
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
  const [beforeRace] = await database.sql<{ run: unknown; review: unknown }[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${currentReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `

  let releaseNewer!: () => void
  let reportInserted!: () => void
  const release = new Promise<void>((resolve) => { releaseNewer = resolve })
  const inserted = new Promise<void>((resolve) => { reportInserted = resolve })
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
    await release
  })
  await inserted
  const racedCallback = (async () => {
    const [result] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_lifecycle_evidence_v3(
        ${currentDispatchId}::uuid, ${callbackToken}::uuid,
        'implementation-thread', 'implementation-turn',
        'thedoughmonster/momi-symphony', 'main',
        'mox-260-independent-pr-review', 16, 'validating', 'running',
        ${newHead}, ${nextHead}, null, 'raced-new-head-callback'
      ) as recorded
    `
    return result.recorded
  })()
  const deadline = Date.now() + 2_000
  let advisoryWaitObserved = false
  try {
    while (!advisoryWaitObserved && Date.now() < deadline) {
      const [waiting] = await database.sql<{ waiting: boolean }[]>`
        select exists (
          select 1 from pg_catalog.pg_locks
          where locktype = 'advisory' and not granted
        ) as waiting
      `
      advisoryWaitObserved = waiting.waiting
      if (!advisoryWaitObserved) await new Promise((resolve) => setTimeout(resolve, 10))
    }
  } finally {
    releaseNewer()
  }
  await newerGeneration
  assert.equal(advisoryWaitObserved, true)
  assert.equal(await racedCallback, false)

  const [afterRace] = await database.sql<typeof beforeRace[]>`
    select to_jsonb(run) as run, to_jsonb(review) as review
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = ${currentReviewAttemptId}::uuid
    where run.dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(afterRace, beforeRace)
})
