import type { ClaimedDispatch, TerminalInput } from "./types.ts"

export function buildLinearComment(work: ClaimedDispatch, terminal?: TerminalInput): string {
  const marker = `<!-- momi-agent-control:${work.work_id} -->`
  const task = work.thread_id
    ? `- Codex task: \`${work.thread_id}\` / turn \`${work.turn_id}\``
    : "- Codex task: not created"
  const state = terminal
    ? `- Final disposition: ${terminal.terminal_disposition}\n` +
      `- Readiness: ${terminal.readiness_result}\n` +
      `- Archived at: ${terminal.archived_at}\n` +
      `- Summary: ${terminal.summary || "No summary provided."}`
    : work.rejection_code
    ? `- Final disposition: rejected (${work.rejection_code})`
    : "- Run state: task accepted; terminal result pending"
  return `${marker}\n## Codex run\n\n- Action: \`execute-run\`\n` +
    `- Dispatch: \`${work.work_id}\`\n${task}\n` +
    `- Symphony: intentionally not invoked by the direct Codex executor\n` +
    `- Recorded at: ${new Date().toISOString()}\n${state}`
}
