import type { AppServerClient, HostAcceptance, HostConfiguration, HostDispatch } from "./types.ts"
import { REVIEW_FINDING_PATH_PATTERN } from "../../agent-control/src/independent_review.ts"
import { prepareReviewWorkspace } from "./prepare_review_workspace.ts"

export type HostStartObserver = {
  threadStarted?: (threadId: string) => Promise<void>
  turnStarted?: (threadId: string, turnId: string) => Promise<void>
}

export async function startHostTask(
  client: AppServerClient,
  config: HostConfiguration,
  input: HostDispatch,
  reviewWorkspace: typeof prepareReviewWorkspace = prepareReviewWorkspace,
  observer: HostStartObserver = {},
): Promise<HostAcceptance> {
  const cwd = input.schema_version === 4
    ? await reviewWorkspace(config, input) : config.workspaceRoot
  let reusedReviewerThread = false
  if (input.schema_version === 4 && input.review_thread_id) {
    reusedReviewerThread = await client.request("thread/unarchive", {
      threadId: input.review_thread_id,
    }).then(() => true, () => false)
  }
  let threadId: string
  if (input.schema_version === 4 && input.review_thread_id && reusedReviewerThread) {
    threadId = input.review_thread_id
  } else {
    try {
      threadId = (await client.request<{ thread: { id: string } }>("thread/start", {
        cwd, serviceName: "momi-agent-control", threadSource: "momi_agent_control",
      })).thread.id
    } catch (error) { throw classifyStartError(error) }
  }
  if (!threadId) throw new Error("host_start_ambiguous")
  try { await observer.threadStarted?.(threadId) }
  catch { throw new Error("host_start_ambiguous") }
  if (!(input.schema_version === 4 && input.review_thread_id && reusedReviewerThread)) {
    await client.request("thread/name/set", { threadId, name: input.thread_name })
      .catch(() => undefined)
  }
  const reviewMode = reusedReviewerThread ? "bounded_reverification" :
    input.review_thread_id ? "fresh_recovery" : "fresh"
  const volatileContext = input.schema_version === 4
    ? `Review mode: ${reviewMode}\n${input.volatile_context
      .replace(/^Review mode: [^\n]*\n?/gm, "")}`
    : input.schema_version === 3 ? input.volatile_context : ""
  const turnInput: Record<string, unknown> = {
    threadId, clientUserMessageId: input.work_id,
    approvalPolicy: "never", sandboxPolicy: input.schema_version === 4
      ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" },
    ...(input.schema_version === 4 ? { runtimeWorkspaceRoots: [cwd] } : {}),
    input: input.schema_version === 3 || input.schema_version === 4
      ? [{ type: "text", text: input.stable_instruction, text_elements: [] },
        { type: "text", text: volatileContext, text_elements: [] },
        ...(input.schema_version === 4 ? [{ type: "text",
          text: `Host-attested review mode: ${reviewMode}.`, text_elements: [] }] : [])]
      : [{ type: "text", text: input.instruction, text_elements: [] }],
    responsesapiClientMetadata: { work_id: input.work_id,
      issue_identifier: input.issue_identifier,
      policy_version: input.policy_version,
      stable_prefix_fingerprint: input.stable_prefix_fingerprint,
      context_fingerprint: input.context_fingerprint },
  }
  if (input.schema_version === 4) {
    turnInput.responsesapiClientMetadata = {
      ...(turnInput.responsesapiClientMetadata as Record<string, unknown>),
      runtime_role: "independent_reviewer",
      implementation_dispatch_id: input.review_subject?.implementation_dispatch_id,
      review_generation: input.review_subject?.generation,
      review_mode: reviewMode,
    }
    turnInput.outputSchema = { type: "object", additionalProperties: false,
      required: ["result", "findings", "artifact_ref"], properties: {
        result: { enum: ["accepted", "changes_requested", "inconclusive", "escalate"] },
        findings: { type: "array", maxItems: 100, items: { type: "object",
          additionalProperties: false,
          required: ["id", "severity", "category", "path", "line", "contract",
            "required_outcome", "evidence"], properties: {
            id: { type: "string", minLength: 3, maxLength: 120 },
            severity: { enum: ["blocking", "nonblocking"] },
            category: { type: "string", maxLength: 120 },
            path: { type: "string", minLength: 1, maxLength: 500,
              pattern: REVIEW_FINDING_PATH_PATTERN },
            line: { type: ["integer", "null"], minimum: 1 },
            contract: { type: "string", minLength: 1, maxLength: 2000 },
            required_outcome: { type: "string", minLength: 1, maxLength: 2000 },
            evidence: { type: "string", minLength: 1, maxLength: 2000 },
          } } }, artifact_ref: { type: "string", minLength: 1, maxLength: 500 } } }
  } else if (input.interaction_mode === "one_shot") {
    turnInput.outputSchema = { type: "object", additionalProperties: false,
      required: ["readiness_result", "disposition", "summary"], properties: {
        readiness_result: { enum: ["ready", "unready", "failed"] },
        disposition: { enum: ["completed", "failed", "interrupted"] },
        summary: { type: "string", maxLength: 1000 } } }
  }
  let turn: { turn: { id: string } }
  try { turn = await client.request<{ turn: { id: string } }>("turn/start", turnInput) }
  catch (error) { throw classifyStartError(error) }
  if (!turn.turn.id) throw new Error("host_start_ambiguous")
  try { await observer.turnStarted?.(threadId, turn.turn.id) }
  catch { throw new Error("host_start_ambiguous") }
  return { thread_id: threadId, turn_id: turn.turn.id }
}

function classifyStartError(error: unknown): Error {
  if (error instanceof Error && ["codex_proxy_not_connected", "codex_proxy_write_failed",
    "codex_app_server_error"].includes(error.message)) return error
  return new Error("host_start_ambiguous")
}
