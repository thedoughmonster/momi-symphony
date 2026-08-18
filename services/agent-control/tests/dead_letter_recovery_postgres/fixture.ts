import type { Sql } from "postgres"

export const dispatchId = "075a2ccc-d6d0-4b06-9f70-8b67702f517c"
export const projectId = "a7932d3c-82c7-477b-9942-3ccaf7a39d06"
export const stableRoute = "https://momi-agent-control.doh.monster/v1/dispatch"
export const priorCapabilityHash = "a".repeat(64)

export type FixtureOverrides = {
  workStatus?: string
  attemptCount?: number
  errorCode?: string
  hostAccepted?: boolean
  hostIdentity?: boolean
  completed?: boolean
  terminal?: boolean
  mappingActive?: boolean
  mappingRepository?: string
  mappingBaseBranch?: string
  mappingRoute?: string
}

export async function resetFixture(
  sql: Sql,
  overrides: FixtureOverrides = {},
): Promise<void> {
  await sql`truncate momi_agent_ops.run_records, momi_agent_ops.dispatches,
    momi_agent_ops.project_mappings`
  await sql`insert into momi_agent_ops.project_mappings (
    linear_project_id, repository, base_branch, active, host_dispatch_url
  ) values (
    ${projectId}::uuid,
    ${overrides.mappingRepository ?? "thedoughmonster/momi-backend"},
    ${overrides.mappingBaseBranch ?? "dev"},
    ${overrides.mappingActive ?? true},
    ${overrides.mappingRoute ?? stableRoute}
  )`
  await sql`insert into momi_agent_ops.dispatches (
    dispatch_id, linear_issue_identifier, linear_project_id, action,
    mapped_repository, mapped_base_branch, work_status, attempt_count,
    next_attempt_at, capability_token_hash, last_error_code,
    host_accepted_at, host_callback_token_hash, codex_thread_id,
    codex_turn_id, completed_at, cancellation_state, recovery_state
  ) values (
    ${dispatchId}::uuid, 'MOX-140', ${projectId}::uuid, 'execute-run',
    'thedoughmonster/momi-backend', 'dev',
    ${overrides.workStatus ?? "dead_letter"}, ${overrides.attemptCount ?? 8},
    now(), ${priorCapabilityHash}, ${overrides.errorCode ?? "codex_host_delivery_failed"},
    ${overrides.hostAccepted ? new Date() : null},
    ${overrides.hostIdentity ? "b".repeat(64) : null},
    ${overrides.hostIdentity ? "thread-test" : null},
    ${overrides.hostIdentity ? "turn-test" : null},
    ${overrides.completed ? new Date() : null}, 'not_requested', 'not_requested'
  )`
  await sql`insert into momi_agent_ops.run_records (
    dispatch_id, readiness_result, terminal_disposition, terminal_at,
    archive_state, archived_at
  ) values (
    ${dispatchId}::uuid, 'pending',
    ${overrides.terminal ? "failed" : null},
    ${overrides.terminal ? new Date() : null},
    'pending', null
  )`
}
