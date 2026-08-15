import type { ClaimedDispatch, TerminalInput } from "./types.ts"

export function buildLinearComment(work: ClaimedDispatch, terminal?: TerminalInput): string {
  const marker = `<!-- momi-agent-control:${work.work_id} -->`
  if (work.action === "run-discovery") {
    if (work.rejection_code) return `${marker}\nDiscovery unavailable · ${work.rejection_code}.`
    if (terminal) return `${marker}\nDiscovery stopped · ${terminal.summary || "Task archived."}`
    return `${marker}\nDiscovery active · continue in Codex task ` +
      `\`${work.issue_identifier} · interactive discovery\`.`
  }
  if (work.action === "cancel-run") {
    if (work.rejection_code) {
      return `${marker}\n## Codex run cancellation\n\n- Action: \`cancel-run\`\n` +
        `- Dispatch: \`${work.work_id}\`\n- Final disposition: rejected ` +
        `(${work.rejection_code})\n- Recorded at: ${new Date().toISOString()}\n` +
        "The project has no active agent-control mapping."
    }
    const target = work.target_dispatch_id
      ? `\`${work.target_dispatch_id}\`` : "no matching execute-run"
    const summaries = {
      not_requested: "Cancellation has not been evaluated.",
      queued_cancelled: "Queued work was withdrawn before host delivery.",
      requested: "The active Codex turn received an idempotent interruption request.",
      already_terminal: "The target run was already terminal; no interruption was needed.",
      no_target: "No prior execute-run exists for this issue.",
      operator_intervention: "Host delivery is ambiguous; operator intervention is required.",
    }
    return `${marker}\n## Codex run cancellation\n\n- Action: \`cancel-run\`\n` +
      `- Dispatch: \`${work.work_id}\`\n- Target dispatch: ${target}\n` +
      `- Final disposition: ${work.cancellation_state}\n` +
      `- Recorded at: ${new Date().toISOString()}\n` + summaries[work.cancellation_state]
  }
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
  const parent = work.parent_dispatch_id
    ? `- Parent dispatch: \`${work.parent_dispatch_id}\`\n` : ""
  return `${marker}\n## Codex run\n\n- Action: \`${work.action}\`\n` +
    `- Dispatch: \`${work.work_id}\`\n${parent}${task}\n` +
    `- Symphony: intentionally not invoked by the direct Codex executor\n` +
    `- Recorded at: ${new Date().toISOString()}\n${state}`
}
