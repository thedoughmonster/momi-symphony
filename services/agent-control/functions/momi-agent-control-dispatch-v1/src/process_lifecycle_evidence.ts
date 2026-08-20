import { reconcileAgentState } from "./agent_state_projection.ts"
import { recordLifecycleEvidence } from "./record_lifecycle_evidence.ts"
import type { LifecycleEvidenceInput } from "./types.ts"

export async function processLifecycleEvidence(
  input: LifecycleEvidenceInput,
  record: (input: LifecycleEvidenceInput) => Promise<boolean> = recordLifecycleEvidence,
  project: (dispatchId: string) => Promise<unknown> = reconcileAgentState,
): Promise<{ ok: true; disposition: "recorded" }> {
  if (!await record(input)) throw new Error("lifecycle_evidence_record_refused")
  await project(input.work_id)
  return { ok: true, disposition: "recorded" }
}
