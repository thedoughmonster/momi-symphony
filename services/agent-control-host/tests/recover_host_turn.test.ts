import assert from "node:assert/strict"
import test from "node:test"

import { recoverHostTurn } from "../src/recover_host_turn.ts"
import type { AppServerClient, HostRecord, TurnShape } from "../src/types.ts"

const record = { threadId: "thread-1", turnId: "turn-1" } as HostRecord

function client(turns: TurnShape[]): AppServerClient {
  return { connect: () => Promise.resolve(), onNotification: () => {},
    request: <T>() => Promise.resolve({ thread: { turns } } as T) }
}

test("host turn recovery reports running, terminal, or missing current state", async () => {
  assert.deepEqual(await recoverHostTurn(client([{ id: "turn-1", status: "inProgress",
    items: [] }]), record, false), { state: "running" })
  const terminal = { id: "turn-1", status: "completed" as const, items: [] }
  assert.deepEqual(await recoverHostTurn(client([terminal]), record, false),
    { state: "terminal", turn: terminal })
  assert.deepEqual(await recoverHostTurn(client([]), record, false), { state: "missing" })
})
