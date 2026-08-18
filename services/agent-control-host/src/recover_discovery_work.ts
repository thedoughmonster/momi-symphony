import { recoveryFingerprint } from "./recovery_fingerprint.ts"
import type { HostLedger } from "./host_ledger.ts"
import type { AppServerClient, HostRecord, HostRecovery,
  HostRecoveryResult, TurnShape } from "./types.ts"

export async function recoverDiscoveryWork(
  client: AppServerClient,
  ledger: HostLedger,
  input: HostRecovery,
  callback: (record: HostRecord) => Promise<void>,
): Promise<HostRecoveryResult> {
  const target = ledger.get(input.target_work_id)
  if (!target) return { recovery_state: "no_target" }
  if (target.interactionMode !== "interactive" || !target.threadId || !target.turnId) {
    return { recovery_state: "ambiguous_target" }
  }
  const fingerprint = recoveryFingerprint(input)
  const existing = ledger.getRecovery(input.work_id)
  if (existing) {
    await ledger.reserveRecovery(input.work_id, fingerprint, input.target_work_id)
    if (existing.state !== "reserved") return { recovery_state: existing.state }
  }
  if (target.state === "terminal") {
    if (!existing) await ledger.reserveRecovery(input.work_id, fingerprint, input.target_work_id)
    if (!target.callbackSent) {
      await callback(target); await ledger.callbackSent(target.workId)
    }
    await ledger.completeRecovery(input.work_id, "already_archived")
    return { recovery_state: "already_archived" }
  }
  if (!["accepted", "interactive"].includes(target.state)) {
    return { recovery_state: "ambiguous_target" }
  }
  const read = await client.request<{ thread: { turns: TurnShape[] } }>("thread/read",
    { threadId: target.threadId, includeTurns: true })
  const storedTurn = read.thread.turns.find((turn) => turn.id === target.turnId)
  const activeTurns = read.thread.turns.filter((turn) => turn.status === "inProgress")
  if (!storedTurn || activeTurns.length > 1) return { recovery_state: "ambiguous_target" }
  if (!existing) await ledger.reserveRecovery(input.work_id, fingerprint, input.target_work_id)
  await ledger.recoveryRequested(target.workId)
  let interrupted = false
  if (activeTurns[0]) {
    interrupted = true
    await client.request("turn/interrupt", {
      threadId: target.threadId, turnId: activeTurns[0].id,
    })
    const confirmed = await client.request<{ thread: { turns: TurnShape[] } }>("thread/read",
      { threadId: target.threadId, includeTurns: true })
    if (confirmed.thread.turns.some((turn) => turn.status === "inProgress")) {
      throw new Error("host_recovery_turn_pending")
    }
  }
  await client.request("thread/archive", { threadId: target.threadId })
  const terminal = await ledger.terminal(target.workId, { readiness_result: "ready",
    terminal_disposition: interrupted ? "interrupted" : "completed",
    summary: "Interactive discovery task recovered and archived." },
  new Date().toISOString())
  await callback(terminal); await ledger.callbackSent(target.workId)
  await ledger.completeRecovery(input.work_id, "recovered")
  return { recovery_state: "recovered" }
}
