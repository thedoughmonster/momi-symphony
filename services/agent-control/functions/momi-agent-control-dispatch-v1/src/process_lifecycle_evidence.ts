import { reconcileAgentState } from "./agent_state_projection.ts"
import { recordLifecycleEvidence } from "./record_lifecycle_evidence.ts"
import type { LifecycleEvidenceInput } from "./types.ts"
import { processReviewRequest } from "./review_controller.ts"

export async function processLifecycleEvidence(
  input: LifecycleEvidenceInput,
  record: (input: LifecycleEvidenceInput) => Promise<boolean> = recordLifecycleEvidence,
  project: (dispatchId: string) => Promise<unknown> = reconcileAgentState,
  review: (input: import("./types.ts").ReviewRequestInput) => Promise<Record<string, unknown>> =
    processReviewRequest,
): Promise<{ ok: true; disposition: "recorded"; review?: Record<string, unknown> }> {
  if (!await record(input)) throw new Error("lifecycle_evidence_record_refused")
  await project(input.work_id)
  const reviewResult = input.phase === "validating" && input.status === "succeeded"
    ? await review({ event: "review_request", work_id: input.work_id,
      capability_token: input.capability_token, thread_id: input.thread_id,
      turn_id: input.turn_id, repository: input.repository, base_branch: input.base_branch,
      branch_name: input.branch_name, pull_request_number: input.pull_request_number })
    : undefined
  return { ok: true, disposition: "recorded", ...(reviewResult ? { review: reviewResult } : {}) }
}
