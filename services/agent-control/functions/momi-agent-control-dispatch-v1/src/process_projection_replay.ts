import { processTerminalProjection, requeueTerminalProjection } from "./terminal_projection.ts"
import type { ProjectionReplayInput } from "./types.ts"

export type ProjectionReplayReceipt = {
  ok: true
  requested: number
  claimed: number
  succeeded: number
  retryable: number
  failed: number
  skipped: number
}

export async function processProjectionReplay(
  input: ProjectionReplayInput,
  requeue: (dispatchId: string) => Promise<boolean> = requeueTerminalProjection,
  project: (dispatchId: string) => ReturnType<typeof processTerminalProjection> =
    processTerminalProjection,
): Promise<ProjectionReplayReceipt> {
  const receipt: ProjectionReplayReceipt = { ok: true,
    requested: input.dispatch_ids.length, claimed: 0, succeeded: 0,
    retryable: 0, failed: 0, skipped: 0 }
  for (const dispatchId of input.dispatch_ids) {
    await requeue(dispatchId)
    const result = await project(dispatchId)
    if (!result.claimed) {
      receipt.skipped += 1
      continue
    }
    receipt.claimed += 1
    if (result.status === "succeeded") receipt.succeeded += 1
    else if (result.status === "failed") receipt.failed += 1
    else receipt.retryable += 1
  }
  return receipt
}
