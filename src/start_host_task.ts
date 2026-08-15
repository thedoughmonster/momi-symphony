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
  const turn = await client.request<{ turn: { id: string } }>("turn/start", {
    threadId: started.thread.id, clientUserMessageId: input.work_id,
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: input.instruction, text_elements: [] }],
    responsesapiClientMetadata: { work_id: input.work_id,
      issue_identifier: input.issue_identifier },
    outputSchema: { type: "object", additionalProperties: false,
      required: ["readiness_result", "disposition", "summary"], properties: {
        readiness_result: { enum: ["ready", "unready", "failed"] },
        disposition: { enum: ["completed", "failed", "interrupted"] },
        summary: { type: "string", maxLength: 1000 } } },
  })
  return { thread_id: started.thread.id, turn_id: turn.turn.id }
}
