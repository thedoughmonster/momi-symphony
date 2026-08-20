import assert from "node:assert/strict"
import test from "node:test"

import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

const staleDispatchId = "30000000-0000-4000-8000-000000000001"
const currentDispatchId = "30000000-0000-4000-8000-000000000002"
const issueId = "30000000-0000-4000-8000-000000000003"
const staleDeliveryId = "30000000-0000-4000-8000-000000000004"
const currentDeliveryId = "30000000-0000-4000-8000-000000000005"
const reviewAttemptId = "30000000-0000-4000-8000-000000000006"
const reviewerDispatchId = "30000000-0000-4000-8000-000000000007"
const callbackToken = "30000000-0000-4000-8000-000000000008"
const currentCallbackToken = "30000000-0000-4000-8000-000000000009"
const oldHead = "a".repeat(40)
const newHead = "b".repeat(40)
const baseSha = "c".repeat(40)

test("a stale dispatch cannot mutate the controlled new-head review generation", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))

  await database.sql`
    insert into momi_agent_ops.raw_webhook_envelopes (
      delivery_id, raw_body, payload, payload_sha256, auth_result
    ) values
      (${staleDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"0".repeat(64)}, 'verified'),
      (${currentDeliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"1".repeat(64)}, 'verified')
  `
  await database.sql`
    insert into momi_agent_ops.dispatches (
      dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
      linear_issue_identifier, linear_issue_url, action, changed_fields,
      mapped_repository, mapped_base_branch, active_states, work_status,
      capability_token_hash, host_callback_token_hash, codex_thread_id,
      codex_turn_id, created_at
    ) values
      (${staleDispatchId}::uuid, ${staleDeliveryId}::uuid, 'stale-generation',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/stale',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active',
        encode(extensions.digest(convert_to(${callbackToken}, 'UTF8'), 'sha256'), 'hex'),
        encode(extensions.digest(convert_to(${callbackToken}, 'UTF8'), 'sha256'), 'hex'),
        'implementation-thread', 'implementation-turn', now() - interval '1 minute'),
      (${currentDispatchId}::uuid, ${currentDeliveryId}::uuid, 'current-generation',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/current',
        ${"execute-run"}, '{}'::jsonb, 'thedoughmonster/momi-symphony', 'main',
        array['In Progress'], 'active',
        ${"2".repeat(64)},
        encode(extensions.digest(convert_to(${currentCallbackToken}, 'UTF8'), 'sha256'), 'hex'),
        'new-implementation-thread', 'new-implementation-turn', now())
  `
  await database.sql`
    insert into momi_agent_ops.run_records (dispatch_id)
    values (${staleDispatchId}::uuid), (${currentDispatchId}::uuid)
  `
  await database.sql`
    insert into momi_agent_ops.review_attempts (
      review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
      generation, repository, base_branch, pull_request_number, head_sha, base_sha,
      profile, policy_version, state, runtime_role, reviewer_capability_token_hash,
      reviewer_thread_id, reviewer_turn_id, packet_fingerprint, packet_artifact_ref,
      rules_fingerprint, risk_dimensions, correction_risk_dimensions
    ) values (
      ${reviewAttemptId}::uuid, ${staleDispatchId}::uuid, ${reviewerDispatchId}::uuid,
      1, 'thedoughmonster/momi-symphony', 'main', 16, ${oldHead}, ${baseSha},
      'high', 'independent-review-v1', 'accepted', 'independent_reviewer',
      ${"4".repeat(64)}, 'reviewer-thread', 'reviewer-turn',
      'fnv1a64:1111111111111111', 'review://MOX-260/exact-head',
      'fnv1a64:2222222222222222', array['security'], array['security'])
  `
  await database.sql`
    update momi_agent_ops.run_records set
      branch_name = 'mox-260-independent-pr-review', pull_request_number = 16,
      head_sha = ${oldHead}, validation_state = 'succeeded', validation_sha = ${oldHead},
      validation_workflow_run_id = 'protected-ci-old-head', review_state = 'succeeded',
      review_sha = ${oldHead}, review_base_sha = ${baseSha},
      review_policy_version = 'independent-review-v1', review_profile = 'high',
      review_receipt_id = ${reviewAttemptId}::uuid, review_check_sha = ${oldHead}
    where dispatch_id = ${staleDispatchId}::uuid
  `

  const [before] = await database.sql<{
    head_sha: string; validation_state: string; validation_sha: string
    review_state: string; review_sha: string; review_receipt_id: string
    attempt_state: string; stale_at: Date | null
  }[]>`
    select run.head_sha, run.validation_state, run.validation_sha,
      run.review_state, run.review_sha, run.review_receipt_id::text,
      review.state as attempt_state, review.stale_at
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = run.review_receipt_id
    where run.dispatch_id = ${staleDispatchId}::uuid
  `
  const [result] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_lifecycle_evidence_v3(
      ${staleDispatchId}::uuid, ${callbackToken}::uuid,
      'implementation-thread', 'implementation-turn',
      'thedoughmonster/momi-symphony', 'main',
      'mox-260-independent-pr-review', 16, 'validating', 'running',
      ${newHead}, null, 'protected-ci-new-head'
    ) as recorded
  `
  assert.equal(result.recorded, false)

  const [after] = await database.sql<typeof before[]>`
    select run.head_sha, run.validation_state, run.validation_sha,
      run.review_state, run.review_sha, run.review_receipt_id::text,
      review.state as attempt_state, review.stale_at
    from momi_agent_ops.run_records run
    join momi_agent_ops.review_attempts review
      on review.review_attempt_id = run.review_receipt_id
    where run.dispatch_id = ${staleDispatchId}::uuid
  `
  assert.deepEqual(after, before)

  await database.sql`
    update momi_agent_ops.run_records set
      branch_name = 'mox-260-independent-pr-review', pull_request_number = 16,
      head_sha = ${oldHead}, validation_state = 'succeeded', validation_sha = ${oldHead},
      validation_workflow_run_id = 'protected-ci-current-head'
    where dispatch_id = ${currentDispatchId}::uuid
  `
  const [currentBefore] = await database.sql<{
    branch_name: string; pull_request_number: string; head_sha: string
    validation_state: string; validation_sha: string
  }[]>`
    select branch_name, pull_request_number::text, head_sha,
      validation_state, validation_sha
    from momi_agent_ops.run_records where dispatch_id = ${currentDispatchId}::uuid
  `
  for (const [branch, pullRequest] of [
    ['different-branch', 16], ['mox-260-independent-pr-review', 17],
  ] as const) {
    const [identityResult] = await database.sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_lifecycle_evidence_v3(
        ${currentDispatchId}::uuid, ${currentCallbackToken}::uuid,
        'new-implementation-thread', 'new-implementation-turn',
        'thedoughmonster/momi-symphony', 'main', ${branch}, ${pullRequest},
        'validating', 'running', ${newHead}, null, 'protected-ci-new-head'
      ) as recorded
    `
    assert.equal(identityResult.recorded, false)
  }
  const [currentAfter] = await database.sql<typeof currentBefore[]>`
    select branch_name, pull_request_number::text, head_sha,
      validation_state, validation_sha
    from momi_agent_ops.run_records where dispatch_id = ${currentDispatchId}::uuid
  `
  assert.deepEqual(currentAfter, currentBefore)
})
