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
  let revocations = await sql<{ implementation_dispatch_id: string;
    repository: string; head_sha: string; publication_pending: boolean;
    revocation_required: boolean }[]>`
    select implementation_dispatch_id::text, repository, head_sha,
      publication_pending, revocation_required
    from momi_agent_ops.prepare_review_check_revocations_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    )`
  const pendingPublications = revocations.filter((row) => row.publication_pending)
  if (pendingPublications.length) {
    for (const publication of pendingPublications) {
      const recovered = await sql<{ recovered: boolean }[]>`
        select momi_agent_ops.recover_abandoned_review_check_publication_v1(
          ${input.work_id}::uuid, ${input.capability_token}::uuid,
          ${publication.implementation_dispatch_id}::uuid,
          ${publication.head_sha}) as recovered`
      if (recovered[0]?.recovered !== true) {
        throw new Error("review_check_publication_pending")
      }
    }
    revocations = await sql<{ implementation_dispatch_id: string;
      repository: string; head_sha: string; publication_pending: boolean;
      revocation_required: boolean }[]>`
      select implementation_dispatch_id::text, repository, head_sha,
        publication_pending, revocation_required
      from momi_agent_ops.prepare_review_check_revocations_v1(
        ${input.work_id}::uuid, ${input.capability_token}::uuid
      )`
    if (revocations.some((row) => row.publication_pending)) {
      throw new Error("review_check_publication_pending")
    }
  }
  for (const revocation of revocations.filter((row) => row.revocation_required)) {
    await (github ??= new GitHubReviewGateway()).publishReviewCheck(
      revocation.repository, revocation.head_sha, false,
      "Implementation lifecycle cancellation revoked merge authority")
    const recorded = await sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_review_check_revocation_v1(
        ${input.work_id}::uuid, ${input.capability_token}::uuid,
        ${revocation.implementation_dispatch_id}::uuid,
        ${revocation.head_sha}) as recorded`
    if (recorded[0]?.recorded !== true) throw new Error("review_check_revocation_refused")
  }
  const fenced = await sql<{ fenced: boolean }[]>`
    select momi_agent_ops.fence_cancellation_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid
    ) as fenced`
  if (fenced[0]?.fenced !== true) throw new Error("cancellation_fence_refused")
  const fencedTargets = await reconstructCancellationTargets(sql, input)
  if (!fencedTargets.length) throw new Error("cancellation_targets_refused")
  claimed.cancellation_target_ids = fencedTargets
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
