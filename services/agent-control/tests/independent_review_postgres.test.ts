import assert from "node:assert/strict"
import test from "node:test"

import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

const implementationDispatchId = "30000000-0000-4000-8000-000000000001"
const issueId = "30000000-0000-4000-8000-000000000002"
const deliveryId = "30000000-0000-4000-8000-000000000003"
const pendingAttemptId = "30000000-0000-4000-8000-000000000004"
const acceptedAttemptId = "30000000-0000-4000-8000-000000000005"
const head = "a".repeat(40)
const nextHead = "b".repeat(40)
const base = "c".repeat(40)
const repository = "thedoughmonster/momi-symphony"
const implementationCapability = "30000000-0000-4000-8000-000000000011"

test("minimal review schema enforces independence, exact-subject uniqueness, and history",
  async (context) => {
    const database = await schedulerHarness.start()
    context.after(() => schedulerHarness.stop(database))

    await database.sql`
      insert into momi_agent_ops.raw_webhook_envelopes (
        delivery_id, raw_body, payload, payload_sha256, auth_result
      ) values (${deliveryId}::uuid, decode('7b7d', 'hex'), '{}'::jsonb,
        ${"0".repeat(64)}, 'verified')
    `
    await database.sql`
      insert into momi_agent_ops.dispatches (
        dispatch_id, receipt_delivery_id, idempotency_key, linear_issue_id,
        linear_issue_identifier, linear_issue_url, action, changed_fields,
        mapped_repository, mapped_base_branch, active_states, work_status,
        capability_token_hash, host_callback_token_hash, codex_thread_id, codex_turn_id
      ) values (
        ${implementationDispatchId}::uuid, ${deliveryId}::uuid, 'review-schema',
        ${issueId}::uuid, 'MOX-260',
        'https://linear.app/moxx-workboard/issue/MOX-260/review-schema',
        ${"execute-run"}, '{}'::jsonb, ${repository}, 'main', array['In Progress'],
        'active', ${"1".repeat(64)}, encode(extensions.digest(convert_to(
          ${implementationCapability}::uuid::text, 'UTF8'), 'sha256'), 'hex'),
        'implementation-thread', 'implementation-turn'
      )
    `
    await database.sql`
      insert into momi_agent_ops.run_records (dispatch_id)
      values (${implementationDispatchId}::uuid)
    `
    await database.sql`
      update momi_agent_ops.run_records set pull_request_number = 16,
        head_sha = ${head}, validation_state = 'succeeded', validation_sha = ${head}
      where dispatch_id = ${implementationDispatchId}::uuid
    `

    await assert.rejects(database.sql`
      insert into momi_agent_ops.review_attempts (
        implementation_dispatch_id, reviewer_dispatch_id,
        reviewer_callback_capability_hash, repository, pull_request_number,
        head_sha, base_sha, policy_version, profile
      ) values (
        ${implementationDispatchId}::uuid, ${implementationDispatchId}::uuid,
        ${"3".repeat(64)}, ${repository}, 16, ${head}, ${base},
        'independent-review-v1', 'high'
      )
    `, /review_attempts_check/)

    await database.sql`
      insert into momi_agent_ops.review_attempts (
        review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
        reviewer_callback_capability_hash, repository, pull_request_number,
        head_sha, base_sha, policy_version, profile
      ) values (
        ${pendingAttemptId}::uuid, ${implementationDispatchId}::uuid,
        '30000000-0000-4000-8000-000000000006'::uuid, ${"4".repeat(64)},
        ${repository}, 16, ${head}, ${base}, 'independent-review-v1', 'high'
      )
    `
    await assert.rejects(database.sql`
      insert into momi_agent_ops.review_attempts (
        implementation_dispatch_id, reviewer_dispatch_id,
        reviewer_callback_capability_hash, repository, pull_request_number,
        head_sha, base_sha, policy_version, profile
      ) values (
        ${implementationDispatchId}::uuid,
        '30000000-0000-4000-8000-000000000007'::uuid, ${"5".repeat(64)},
        ${repository}, 16, ${nextHead}, ${base}, 'independent-review-v1', 'high'
      )
    `, /review_attempts_one_pending_idx/)

    await assert.rejects(database.sql`
      update momi_agent_ops.review_attempts set
        reviewer_identity = 'independent_reviewer',
        reviewer_thread_id = 'implementation-thread', reviewer_turn_id = 'review-turn'
      where review_attempt_id = ${pendingAttemptId}::uuid
    `, /reviewer_identity_not_independent/)

    const recovered = await database.sql<{ recovered: boolean }[]>`
      select momi_agent_ops.recover_missing_review_attempt_v1(
        ${implementationDispatchId}::uuid, ${implementationCapability}::uuid,
        'implementation-thread', 'implementation-turn',
        ${pendingAttemptId}::uuid) as recovered
    `
    assert.equal(recovered[0]?.recovered, true)
    const failed = await database.sql<{ state: string; failure_reason: string }[]>`
      select state, failure_reason from momi_agent_ops.review_attempts
      where review_attempt_id = ${pendingAttemptId}::uuid
    `
    assert.deepEqual(failed[0], { state: "failed", failure_reason: "review_host_missing" })

    await assert.rejects(database.sql`
      insert into momi_agent_ops.review_attempts (
        implementation_dispatch_id, reviewer_dispatch_id,
        reviewer_callback_capability_hash, repository, pull_request_number,
        head_sha, base_sha, policy_version, profile, state, reviewer_identity,
        reviewer_thread_id, reviewer_turn_id, findings, terminal_at
      ) values (
        ${implementationDispatchId}::uuid,
        '30000000-0000-4000-8000-000000000008'::uuid, ${"6".repeat(64)},
        ${repository}, 16, ${nextHead}, ${base}, 'independent-review-v1', 'high',
        'accepted', 'independent_reviewer', 'review-thread-blocked', 'review-turn-blocked',
        '[{"id":"blocking","severity":"blocking"}]'::jsonb, now()
      )
    `, /review_attempts_check/)

    await database.sql`
      insert into momi_agent_ops.review_attempts (
        review_attempt_id, implementation_dispatch_id, reviewer_dispatch_id,
        reviewer_callback_capability_hash, repository, pull_request_number,
        head_sha, base_sha, policy_version, profile, state, reviewer_identity,
        reviewer_thread_id, reviewer_turn_id, findings, terminal_at
      ) values (
        ${acceptedAttemptId}::uuid, ${implementationDispatchId}::uuid,
        '30000000-0000-4000-8000-000000000009'::uuid, ${"7".repeat(64)},
        ${repository}, 16, ${head}, ${base}, 'independent-review-v1', 'high',
        'accepted', 'independent_reviewer', 'review-thread', 'review-turn', '[]'::jsonb,
        now()
      )
    `
    await assert.rejects(database.sql`
      insert into momi_agent_ops.review_attempts (
        implementation_dispatch_id, reviewer_dispatch_id,
        reviewer_callback_capability_hash, repository, pull_request_number,
        head_sha, base_sha, policy_version, profile, state, reviewer_identity,
        reviewer_thread_id, reviewer_turn_id, findings, terminal_at
      ) values (
        ${implementationDispatchId}::uuid,
        '30000000-0000-4000-8000-000000000010'::uuid, ${"8".repeat(64)},
        ${repository}, 16, ${head}, ${base}, 'independent-review-v1', 'low',
        'accepted', 'independent_reviewer', 'review-thread-2', 'review-turn-2',
        '[]'::jsonb, now()
      )
    `, /review_attempts_one_accepted_subject_idx/)

    await assert.rejects(database.sql`
      update momi_agent_ops.review_attempts set findings =
        '[{"id":"late","severity":"nonblocking"}]'::jsonb
      where review_attempt_id = ${acceptedAttemptId}::uuid
    `, /review_attempt_history_immutable/)
    await assert.rejects(database.sql`
      delete from momi_agent_ops.review_attempts
      where review_attempt_id = ${acceptedAttemptId}::uuid
    `, /review_attempt_history_immutable/)
  })
