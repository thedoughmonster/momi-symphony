import assert from "node:assert/strict"
import test from "node:test"

import { extractReviewResult } from "../src/extract_review_result.ts"
import { parseHostDispatch } from "../src/parse_host_dispatch.ts"
import { ReviewCredentialBoundary } from "../src/review_credential_boundary.ts"
import type { HostDispatch, TurnShape } from "../src/types.ts"

const workId = "00000000-0000-4000-8000-000000000001"
const capability = "00000000-0000-4000-8000-000000000002"
const subject = { implementation_dispatch_id: "00000000-0000-4000-8000-000000000003",
  pull_request_number: 16, head_sha: "a".repeat(40), base_sha: "b".repeat(40),
  profile: "high" as const, policy_version: "independent-review-v1" }
const dispatch: HostDispatch = { schema_version: 4, work_id: workId,
  capability_token: capability, issue_id: "00000000-0000-4000-8000-000000000004",
  issue_identifier: "MOX-260", issue_url: "https://linear.app/x/issue/MOX-260/x",
  project_id: "00000000-0000-4000-8000-000000000005",
  project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
  base_branch: "main", active_states: ["In Progress"], interaction_mode: "one_shot",
  thread_name: "MOX-260 · independent review", stable_instruction:
    "Perform read-only independent semantic review of the exact subject only.",
  volatile_context: "Exact bounded packet for the protected revision and complete diff evidence.",
  stable_prefix_fingerprint: "fnv1a64:1111111111111111",
  context_fingerprint: "fnv1a64:2222222222222222",
  policy_version: "independent-review-v1", budget: { model_turns: 16,
    no_progress_cycles: 2, subagents: 0, subagent_depth: 0,
    model_visible_tool_bytes: 96_000, elapsed_ms: 3_600_000 },
  runtime_role: "independent_reviewer",
  review_workspace_id: "00000000-0000-4000-8000-000000000006",
  review_subject: subject }

test("review dispatch keeps exact subject and derives execution only from profile", () => {
  assert.deepEqual(parseHostDispatch(dispatch), dispatch)
  assert.equal(parseHostDispatch({ ...dispatch, budget: { ...dispatch.budget!, model_turns: 8 } }),
    null)
  assert.equal(parseHostDispatch({ ...dispatch, review_subject: {
    ...subject, model: "gpt-5.6-sol" } }), null)
  assert.equal(parseHostDispatch({ ...dispatch, runtime_role: undefined }), null)
})

test("review result is strict and accepted output cannot contain blockers", () => {
  const turn = (value: unknown): TurnShape => ({ status: "completed",
    items: [{ type: "agentMessage", text: JSON.stringify(value) }] }) as TurnShape
  assert.deepEqual(extractReviewResult(turn({ result: "accepted", findings: [] })),
    { result: "accepted", findings: [] })
  assert.equal(extractReviewResult(turn({ result: "accepted", findings: [{ id: "block-1",
    severity: "blocking", category: "correctness", path: "src/a.ts", line: 1,
    contract: "fail closed", required_outcome: "reject", evidence: "accepted" }] })), null)
  assert.equal(extractReviewResult(turn({ result: "accepted", findings: [],
    artifact_ref: "obsolete" })), null)
})

test("review callback capability remains AES-256-GCM sealed with subject-bound AAD", () => {
  const boundary = new ReviewCredentialBoundary(Buffer.alloc(32, 7))
  const sealed = boundary.seal(workId, "dispatch-fingerprint", { capabilityToken: capability,
    threadId: "review-thread", turnId: "review-turn", reviewSubject: subject })
  assert.equal(sealed.algorithm, "aes-256-gcm")
  assert.deepEqual(boundary.open(workId, "dispatch-fingerprint", sealed), {
    capabilityToken: capability, threadId: "review-thread", turnId: "review-turn",
    reviewSubject: subject })
  assert.throws(() => boundary.open(workId, "different-fingerprint", sealed),
    /review_credential_envelope_invalid/)
})
