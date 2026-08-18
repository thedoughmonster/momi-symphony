import type { AppServerClient, HostAcceptance, HostConfiguration, HostDispatch } from "./types.ts"

export async function startHostTask(
  client: AppServerClient,
  config: HostConfiguration,
  input: HostDispatch,
): Promise<HostAcceptance> {
  const started = await client.request<{ thread: { id: string } }>("thread/start", {
    cwd: config.workspaceRoot,
    serviceName: "momi-agent-control", threadSource: "momi_agent_control",
  })
  await client.request("thread/name/set", {
    threadId: started.thread.id, name: input.thread_name,
  })
  const turnInput: Record<string, unknown> = {
    threadId: started.thread.id, clientUserMessageId: input.work_id,
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: input.instruction, text_elements: [] }],
    responsesapiClientMetadata: { work_id: input.work_id,
      issue_identifier: input.issue_identifier },
  }
  if (input.interaction_mode === "one_shot") {
    turnInput.outputSchema = { type: "object", additionalProperties: false,
      required: ["readiness_result", "disposition", "summary"], properties: {
        readiness_result: { enum: ["ready", "unready", "failed"] },
        disposition: { enum: ["completed", "failed", "interrupted"] },
        summary: { type: "string", maxLength: 1000 } } }
  }
  const turn = await client.request<{ turn: { id: string } }>("turn/start", turnInput)
  return { thread_id: started.thread.id, turn_id: turn.turn.id }
}
