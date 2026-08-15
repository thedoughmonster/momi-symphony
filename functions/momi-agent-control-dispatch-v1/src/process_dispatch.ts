import type { DispatchDependencies, DispatchInput } from "./types.ts"

export async function processDispatch(
  input: DispatchInput,
  dependencies: DispatchDependencies,
): Promise<{ ok: boolean; disposition: string; thread_id?: string }> {
  const work = await dependencies.claim(input)
  if (!work) return { ok: true, disposition: "duplicate" }
  try {
    if (work.delivery_phase === "host") {
      const host = await dependencies.callHost(work, input.capability_token)
      if (!await dependencies.hostAccepted(input, host)) {
        throw new Error("host_acceptance_record_failed")
      }
      work.thread_id = host.thread_id
      work.turn_id = host.turn_id
      work.delivery_phase = "writeback"
    }
    if (work.delivery_phase === "cancel_host") {
      const result = await dependencies.callCancel(work, input.capability_token)
      if (!await dependencies.cancellationRecorded(input, result)) {
        throw new Error("cancellation_record_failed")
      }
      work.cancellation_state = result.cancellation_state
      work.delivery_phase = "writeback"
    }
    const commentId = await dependencies.reconcile(work)
    const hasRun = work.action !== "cancel-run" && work.rejection_code === null &&
      work.thread_id !== null
    if (!await dependencies.writeback(input, commentId, hasRun)) {
      throw new Error("linear_writeback_record_failed")
    }
    return work.rejection_code
      ? { ok: true, disposition: "rejected" }
      : work.action === "cancel-run"
      ? { ok: true, disposition: work.cancellation_state }
      : { ok: true, disposition: "active", thread_id: work.thread_id! }
  } catch (error) {
    const code = (error instanceof Error ? error.message : "dispatch_failed")
      .replace(/[^a-z0-9_]/gi, "_").slice(0, 120)
    await dependencies.retry(input, code)
    throw error
  }
}
