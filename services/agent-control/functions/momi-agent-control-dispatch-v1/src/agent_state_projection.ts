import { getDatabase } from "../../../src/database.ts"
import { AGENT_STATES, deriveAgentState } from "./agent_state.ts"
import type { AgentState, AgentStateEvidence } from "./agent_state.ts"
import { createLinearAdapterProfile } from "./linear_issue_adapter.ts"
import { loadLinearIssue } from "./load_linear_issue.ts"
import { writeLinearLabels } from "./write_linear_labels.ts"

type AgentStateProjectionContext = AgentStateEvidence & {
  issue_id: string
  issue_identifier: string
  project_id: string
  repository: string
  base_branch: string
}

export async function reconcileAgentState(dispatchId: string): Promise<AgentState> {
  const context = await loadAgentStateEvidence(dispatchId)
  const desired = deriveAgentState(context)
  const issue = await loadLinearIssue(context.issue_id, createLinearAdapterProfile({
    projectId: context.project_id,
    repository: context.repository,
    baseBranch: context.base_branch,
  }))
  if (issue.identifier !== context.issue_identifier) {
    throw new Error("agent_state_issue_identity_conflict")
  }
  const catalogue = issue.teamLabels.filter((label) => label.parentName === "Agent State")
  const byName = new Map(catalogue.map((label) => [label.name, label]))
  if (catalogue.length !== AGENT_STATES.length || byName.size !== AGENT_STATES.length ||
    AGENT_STATES.some((state) => !byName.has(state))) {
    throw new Error("agent_state_catalogue_incomplete")
  }
  const stateIds = new Set(catalogue.map((label) => label.id))
  const desiredLabel = byName.get(desired)!
  const labelIds = issue.labelRefs.filter((label) => !stateIds.has(label.id))
    .map((label) => label.id)
  labelIds.push(desiredLabel.id)
  const sorted = [...new Set(labelIds)].sort()
  const current = issue.labelRefs.map((label) => label.id).sort()
  if (sorted.join("\n") !== current.join("\n")) {
    await writeLinearLabels(issue.id, sorted)
  }
  if (!await recordAgentStateProjection(dispatchId, desired, desiredLabel.id)) {
    throw new Error("agent_state_projection_fence_lost")
  }
  return desired
}

export async function loadAgentStateEvidence(
  dispatchId: string,
): Promise<AgentStateProjectionContext> {
  const sql = getDatabase()
  const rows = await sql<AgentStateProjectionContext[]>`
    select run.lifecycle_version, work.dispatch_id::text,
      current_work.dispatch_id::text as current_dispatch_id,
      work.linear_issue_id::text as issue_id, work.linear_issue_identifier as issue_identifier,
      work.linear_project_id::text as project_id, work.mapped_repository as repository,
      work.mapped_base_branch as base_branch, work.action, work.source_kind,
      work.work_status, work.attempt_count, work.last_error_code,
      work.host_accepted_at::text, work.cancellation_state, work.cancelled_at::text,
      run.readiness_result, run.terminal_disposition, run.terminal_at::text,
      run.linear_writeback_at::text, run.validation_state, run.validation_sha,
      run.review_state, run.review_sha, run.release_state, run.release_sha,
      run.head_sha, run.merge_sha,
      exists (
        select 1 from momi_agent_ops.dispatches child
        where child.parent_dispatch_id = work.dispatch_id
          and child.work_status not in ('completed', 'cancelled', 'rejected', 'dead_letter')
      ) as has_active_children
    from momi_agent_ops.dispatches work
    join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
    join lateral (
      select newest.dispatch_id
      from momi_agent_ops.dispatches newest
      where newest.linear_issue_id = work.linear_issue_id
        and newest.action not in ('cancel-run', 'recover-discovery')
      order by newest.created_at desc, newest.dispatch_id desc limit 1
    ) current_work on true
    join momi_agent_ops.project_mappings mapping
      on mapping.linear_project_id = work.linear_project_id
      and mapping.active
      and mapping.repository = work.mapped_repository
      and mapping.base_branch = work.mapped_base_branch
    where work.dispatch_id = ${dispatchId}::uuid
      and work.action not in ('cancel-run', 'recover-discovery')
  `
  if (!rows[0]) throw new Error("agent_state_evidence_unavailable")
  return rows[0]
}

async function recordAgentStateProjection(
  dispatchId: string,
  state: AgentState,
  labelId: string,
): Promise<boolean> {
  const sql = getDatabase()
  const rows = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_agent_state_projection_v1(
      ${dispatchId}::uuid, ${state}, ${labelId}::uuid
    ) as recorded
  `
  return rows[0]?.recorded === true
}
