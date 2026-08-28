import type { Sql } from "postgres"

import { getDatabase } from "../../../src/database.ts"
import { reconcileAgentState } from "./agent_state_projection.ts"
import { reconcileTerminal } from "./reconcile_terminal.ts"
import type { LinearProjectionStatus, TerminalProjectionContext } from "./types.ts"

export type TerminalProjectionResult = {
  claimed: boolean
  status: LinearProjectionStatus | "skipped"
}

export type TerminalProjectionDependencies = {
  claim: (dispatchId: string) => Promise<TerminalProjectionContext | null>
  reconcile: typeof reconcileTerminal
  projectState: (dispatchId: string) => Promise<unknown>
  recordResult: (dispatchId: string, projectionAttempt: number, succeeded: boolean,
    commentId: string | null, errorCode: string | null) => Promise<LinearProjectionStatus>
}

function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : "linear_projection_failed")
    .replace(/[^a-z0-9_]/gi, "_").slice(0, 120) || "linear_projection_failed"
}

export async function claimTerminalProjection(
  dispatchId: string,
  sql: Sql = getDatabase(),
): Promise<TerminalProjectionContext | null> {
  const rows = await sql<{
    dispatch_id: string
    issue_id: string
    issue_identifier: string
    action: TerminalProjectionContext["action"]
    thread_id: string
    turn_id: string
    linear_comment_id: string | null
    readiness_result: TerminalProjectionContext["readiness_result"]
    terminal_disposition: TerminalProjectionContext["terminal_disposition"]
    terminal_summary: string
    archived_at: string
    projection_attempt: number
  }[]>`
    select dispatch_id::text, issue_id::text, issue_identifier, action,
      thread_id, turn_id,
      linear_comment_id::text, readiness_result, terminal_disposition,
      terminal_summary, archived_at::text, projection_attempt::integer
    from momi_agent_ops.claim_terminal_projection_v1(${dispatchId}::uuid)
  `
  const row = rows[0]
  return row ? {
    work_id: row.dispatch_id,
    issue_id: row.issue_id,
    issue_identifier: row.issue_identifier,
    action: row.action,
    thread_id: row.thread_id,
    turn_id: row.turn_id,
    linear_comment_id: row.linear_comment_id,
    readiness_result: row.readiness_result,
    terminal_disposition: row.terminal_disposition,
    summary: row.terminal_summary,
    archived_at: row.archived_at,
    projection_attempt: row.projection_attempt,
  } : null
}

export async function recordTerminalProjectionResult(
  dispatchId: string,
  projectionAttempt: number,
  succeeded: boolean,
  commentId: string | null,
  code: string | null,
  sql: Sql = getDatabase(),
): Promise<LinearProjectionStatus> {
  const rows = await sql<{ status: LinearProjectionStatus | null }[]>`
    select momi_agent_ops.record_terminal_projection_result_v1(
      ${dispatchId}::uuid, ${projectionAttempt}::integer, ${succeeded},
      ${commentId}::uuid, ${code}
    ) as status
  `
  if (!rows[0]?.status) throw new Error("terminal_projection_result_refused")
  return rows[0].status
}

export async function requeueTerminalProjection(
  dispatchId: string,
  sql: Sql = getDatabase(),
): Promise<boolean> {
  const rows = await sql<{ requeued: boolean }[]>`
    select momi_agent_ops.requeue_terminal_projection_v1(
      ${dispatchId}::uuid
    ) as requeued
  `
  return rows[0]?.requeued === true
}

export async function listDueTerminalProjectionIds(
  route: { projectId: string; repository: string; baseBranch: string },
  limit = 20,
  sql: Sql = getDatabase(),
): Promise<string[]> {
  const bounded = Math.max(1, Math.min(50, Math.trunc(limit)))
  const rows = await sql<{ dispatch_id: string }[]>`
    select run.dispatch_id::text
    from momi_agent_ops.run_records run
    join momi_agent_ops.dispatches work on work.dispatch_id = run.dispatch_id
    where work.linear_project_id = ${route.projectId}::uuid
      and work.mapped_repository = ${route.repository}
      and work.mapped_base_branch = ${route.baseBranch}
      and run.terminal_at is not null
      and run.linear_projection_status in ('pending', 'retryable', 'in_progress')
      and run.linear_projection_next_attempt_at <= now()
      and (run.linear_projection_status <> 'in_progress'
        or run.linear_projection_lease_expires_at <= now())
    order by run.linear_projection_next_attempt_at, run.dispatch_id
    limit ${bounded}
  `
  return rows.map((row) => row.dispatch_id)
}

function defaultDependencies(): TerminalProjectionDependencies {
  return {
    claim: claimTerminalProjection,
    reconcile: reconcileTerminal,
    projectState: reconcileAgentState,
    recordResult: recordTerminalProjectionResult,
  }
}

export async function processTerminalProjection(
  dispatchId: string,
  dependencies: TerminalProjectionDependencies = defaultDependencies(),
): Promise<TerminalProjectionResult> {
  const context = await dependencies.claim(dispatchId)
  if (!context) return { claimed: false, status: "skipped" }
  let commentId: string
  try {
    commentId = await dependencies.reconcile(context, context)
    await dependencies.projectState(dispatchId)
  } catch (error) {
    return { claimed: true, status: await dependencies.recordResult(
      dispatchId, context.projection_attempt, false, null, errorCode(error),
    ) }
  }
  return { claimed: true, status: await dependencies.recordResult(
    dispatchId, context.projection_attempt, true, commentId, null,
  ) }
}
