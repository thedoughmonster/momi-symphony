import type { AppServerClient, HostRecord, TurnShape } from "./types.ts"

export async function recoverHostTurn(
  client: AppServerClient,
  record: HostRecord,
  subscribe: boolean,
): Promise<TurnShape | undefined> {
  if (!record.threadId || !record.turnId) return undefined
  const method = subscribe ? "thread/resume" : "thread/read"
  const params = subscribe
    ? { threadId: record.threadId }
    : { threadId: record.threadId, includeTurns: true }
  const response = await client.request<{ thread: { turns: TurnShape[] } }>(method, params)
  return response.thread.turns.find((candidate) => candidate.id === record.turnId)
}
