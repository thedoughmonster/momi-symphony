import type { TerminalInput } from "./types.ts"

export async function processTerminal(
  input: TerminalInput,
  record: (terminal: TerminalInput) => Promise<import("./types.ts").TerminalContext | null>,
  reconcile: (context: import("./types.ts").TerminalContext,
    terminal: TerminalInput) => Promise<string>,
  writeback: (terminal: TerminalInput, commentId: string) => Promise<boolean>,
  project: (dispatchId: string) => Promise<unknown>,
): Promise<{ ok: boolean; disposition: string }> {
  const context = await record(input)
  if (!context) throw new Error("terminal_record_refused")
  const commentId = await reconcile(context, input)
  if (!await writeback(input, commentId)) throw new Error("terminal_writeback_record_failed")
  await project(input.work_id)
  return { ok: true, disposition: "completed" }
}
