import { createHash } from "node:crypto"

export const TOOL_RECEIPT_SCHEMA_VERSION = 1 as const
export const MAX_DIAGNOSTIC_BYTES = 4_096

export type ToolReceipt = {
  schema_version: typeof TOOL_RECEIPT_SCHEMA_VERSION
  status: "succeeded" | "failed"
  command_id: string
  duration_ms: number
  output_hash: string
  artifact_ref: string
  error_code?: string
  repair_class?: string
  path?: string
  line?: number
  diagnostic_excerpt?: string
}

const protectedValue = /(bearer\s+[a-z0-9._~+/=-]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi

export function redactProtected(text: string): string {
  return text.replace(protectedValue, "[REDACTED]")
}

export function compactToolReceipt(input: {
  status: "succeeded" | "failed"; command_id: string; duration_ms: number
  output: string; artifact_ref: string; error_code?: string; repair_class?: string
  path?: string; line?: number
}): ToolReceipt {
  const redacted = redactProtected(input.output)
  const excerpt = Buffer.from(redacted).subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")
  return { schema_version: TOOL_RECEIPT_SCHEMA_VERSION, status: input.status,
    command_id: input.command_id, duration_ms: Math.max(0, Math.floor(input.duration_ms)),
    output_hash: `sha256:${createHash("sha256").update(redacted).digest("hex")}`,
    artifact_ref: input.artifact_ref,
    ...(input.status === "failed" ? { error_code: input.error_code ?? "tool_failed",
      repair_class: input.repair_class ?? "investigate", path: input.path,
      line: input.line, diagnostic_excerpt: excerpt } : {}) }
}

export type ExecutionCheckpoint = {
  schema_version: 1
  work_id: string
  milestone: "investigation_complete" | "plan_accepted" | "code_committed" |
    "focused_validation_complete" | "ci_evidence_received"
  issue_revision: string
  tree_hash: string
  policy_version: string
  completed_receipts: string[]
  failure_fingerprints: string[]
}

export function continuationDelta(checkpoint: ExecutionCheckpoint, input: {
  issue_revision: string; tree_hash: string; policy_version: string
  diagnostic_fingerprint?: string; evidence: unknown
}): { checkpoint: ExecutionCheckpoint; new_evidence: unknown; repeated_failure_count: number } {
  if (checkpoint.issue_revision !== input.issue_revision) throw new Error("checkpoint_issue_changed")
  if (checkpoint.tree_hash !== input.tree_hash) throw new Error("checkpoint_tree_changed")
  if (checkpoint.policy_version !== input.policy_version) throw new Error("checkpoint_policy_changed")
  const repeated = input.diagnostic_fingerprint
    ? checkpoint.failure_fingerprints.filter((value) => value === input.diagnostic_fingerprint).length
    : 0
  if (repeated >= 2) throw new Error("repeated_failure_budget_exhausted")
  return { checkpoint, new_evidence: input.evidence, repeated_failure_count: repeated }
}
