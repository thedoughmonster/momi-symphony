import { getDatabase } from "../../../src/database.ts"
import type { ClaimedDispatch, DispatchInput } from "./types.ts"

export async function claimDispatch(input: DispatchInput): Promise<ClaimedDispatch | null> {
  const sql = getDatabase()
  const rows = await sql<ClaimedDispatch[]>`
    select work_id::text, issue_id::text, issue_identifier, action, source_kind,
      validation_profile, issue_url,
      project_id::text, project_name, repository, base_branch, active_states,
      host_dispatch_url, rejection_code, delivery_phase, thread_id, turn_id,
      linear_comment_id::text, parent_dispatch_id::text, target_dispatch_id::text,
      cancellation_target_ids::text[],
      cancellation_state, recovery_state
    from momi_agent_ops.claim_dispatch_v6(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    )
  `
  const claimed = rows[0] ?? null
  if (claimed?.delivery_phase !== "cancel_host" ||
    !claimed.cancellation_target_ids?.length) return claimed
  const fenced = await sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    ) as fenced`
  if (fenced[0]?.fenced !== true) throw new Error("cancellation_fence_refused")
  const reviewers = await sql<{ reviewer_dispatch_id: string }[]>`
    select reviewer_dispatch_id::text
    from momi_agent_ops.review_attempts
    where implementation_dispatch_id = any(${claimed.cancellation_target_ids}::uuid[])
      and state in ('running', 'changes_requested')
      and reviewer_thread_id is not null and reviewer_turn_id is not null
    order by reviewer_dispatch_id`
  claimed.cancellation_target_ids = [...new Set([
    ...claimed.cancellation_target_ids,
    ...reviewers.map((review) => review.reviewer_dispatch_id),
  ])].sort()
  return claimed
}
