import type { TerminalInput } from "./types.ts"
import type { TerminalProjectionResult } from "./terminal_projection.ts"

export async function processTerminal(
  input: TerminalInput,
  record: (terminal: TerminalInput) => Promise<import("./types.ts").TerminalContext | null>,
  project: (dispatchId: string) => Promise<TerminalProjectionResult>,
): Promise<{ ok: boolean; disposition: string; execution_status: string;
  projection_status: string }> {
  const context = await record(input)
  if (!context) throw new Error("terminal_record_refused")
  const projection = await project(input.work_id)
  const executionStatus = input.terminal_disposition === "completed" ? "succeeded"
    : input.terminal_disposition
  return { ok: true, disposition: input.terminal_disposition,
    execution_status: executionStatus, projection_status: projection.status }
}
