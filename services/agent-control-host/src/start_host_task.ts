import type { AppServerClient, HostAcceptance, HostConfiguration, HostDispatch } from "./types.ts"

export async function startHostTask(
  client: AppServerClient,
  config: HostConfiguration,
  input: HostDispatch,
): Promise<HostAcceptance> {
  const threadId = input.schema_version === 4 && input.review_thread_id
    ? input.review_thread_id
    : (await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: config.workspaceRoot,
      serviceName: "momi-agent-control", threadSource: "momi_agent_control",
    })).thread.id
  if (!(input.schema_version === 4 && input.review_thread_id)) {
    await client.request("thread/name/set", { threadId, name: input.thread_name })
  }
  const turnInput: Record<string, unknown> = {
    threadId, clientUserMessageId: input.work_id,
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    input: input.schema_version === 3 || input.schema_version === 4
      ? [{ type: "text", text: input.stable_instruction, text_elements: [] },
        { type: "text", text: input.volatile_context, text_elements: [] }]
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
      review_mode: input.review_thread_id ? "bounded_reverification" : "fresh",
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
            path: { type: "string", minLength: 1, maxLength: 500 },
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
  const turn = await client.request<{ turn: { id: string } }>("turn/start", turnInput)
  return { thread_id: threadId, turn_id: turn.turn.id }
}
