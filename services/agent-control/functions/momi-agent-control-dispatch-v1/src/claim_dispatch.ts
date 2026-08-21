import { getDatabase } from "../../../src/database.ts"
import { GitHubReviewGateway } from "./github_review_gateway.ts"
import type { ClaimedDispatch, DispatchInput } from "./types.ts"

export async function claimDispatch(input: DispatchInput,
  sql = getDatabase(), github?: GitHubReviewGateway): Promise<ClaimedDispatch | null> {
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
  if (!claimed || claimed.action !== "cancel-run" || claimed.rejection_code) return claimed
  const initialTargets = await reconstructCancellationTargets(sql, input)
  if (!initialTargets.length) return claimed
  claimed.cancellation_state = "requested"
  const fenced = await sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    ) as fenced`
  if (fenced[0]?.fenced !== true) throw new Error("cancellation_fence_refused")
  const projections = await sql<{ repository: string; head_sha: string }[]>`
    select distinct review.repository, review.head_sha
    from momi_agent_ops.review_attempts review
    where review.implementation_dispatch_id = any(${initialTargets}::uuid[])
      or review.reviewer_dispatch_id = any(${initialTargets}::uuid[])`
  for (const projection of projections) {
    try {
      await (github ??= new GitHubReviewGateway()).projectReviewCheck(
        projection.repository, projection.head_sha,
        "failure", "Independent review authority was canceled")
    } catch { /* Canonical database cancellation is already committed. */ }
  }
  claimed.cancellation_target_ids = initialTargets
  claimed.delivery_phase = "cancel_host"
  return claimed
}

async function reconstructCancellationTargets(sql: ReturnType<typeof getDatabase>,
  input: DispatchInput): Promise<string[]> {
  const rows = await sql<{ target_ids: string[] | null }[]>`
    select momi_agent_ops.reconstruct_cancellation_targets_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid)::text[] as target_ids`
  return rows[0]?.target_ids ?? []
}
