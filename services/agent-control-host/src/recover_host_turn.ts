import type { AppServerClient, HostRecord, TurnShape } from "./types.ts"

export type HostTurnRecovery = { state: "running" } |
  { state: "terminal"; turn: TurnShape } | { state: "missing" }

export async function recoverHostTurn(
  client: AppServerClient,
  record: HostRecord,
  subscribe: boolean,
): Promise<HostTurnRecovery> {
  if (!record.threadId || !record.turnId) return { state: "missing" }
  const method = subscribe ? "thread/resume" : "thread/read"
  const params = subscribe
    ? { threadId: record.threadId }
    : { threadId: record.threadId, includeTurns: true }
  const response = await client.request<{ thread: { turns: TurnShape[] } }>(method, params)
  const turn = response.thread.turns.find((candidate) => candidate.id === record.turnId)
  if (!turn) return { state: "missing" }
  return turn.status === "inProgress" ? { state: "running" } : { state: "terminal", turn }
}
