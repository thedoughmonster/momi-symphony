import type { DispatchDependencies, DispatchInput } from "./types.ts"

export async function processDispatch(
  input: DispatchInput,
  dependencies: DispatchDependencies,
): Promise<{ ok: boolean; disposition: string; thread_id?: string }> {
  const work = await dependencies.claim(input)
  if (!work) return { ok: true, disposition: "duplicate" }
  try {
    if (work.delivery_phase === "host") {
      await dependencies.project(work.work_id)
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
    if (work.delivery_phase === "recover_host") {
      await dependencies.reconcile(work)
      const result = await dependencies.callRecovery(work, input.capability_token)
      if (!await dependencies.recoveryRecorded(input, result)) {
        throw new Error("recovery_record_failed")
      }
      work.recovery_state = result.recovery_state
      work.delivery_phase = "writeback"
    }
    const commentId = await dependencies.reconcile(work)
    if (!work.rejection_code && !["cancel-run", "recover-discovery"].includes(work.action)) {
      await dependencies.project(work.work_id)
    }
    if (!await dependencies.writeback(input, commentId)) {
      throw new Error("linear_writeback_record_failed")
    }
    if (work.action === "cancel-run" && work.target_dispatch_id) {
      await dependencies.project(work.target_dispatch_id)
    }
    return work.rejection_code
      ? { ok: true, disposition: "rejected" }
      : work.action === "cancel-run"
      ? { ok: true, disposition: work.cancellation_state }
      : work.action === "recover-discovery"
      ? { ok: true, disposition: work.recovery_state }
      : { ok: true, disposition: "active", thread_id: work.thread_id! }
  } catch (error) {
    const code = (error instanceof Error ? error.message : "dispatch_failed")
      .replace(/[^a-z0-9_]/gi, "_").slice(0, 120)
    await dependencies.retry(input, code)
    if (!work.rejection_code && !["cancel-run", "recover-discovery"].includes(work.action)) {
      await dependencies.project(work.work_id).catch(() => undefined)
    }
    throw error
  }
}
