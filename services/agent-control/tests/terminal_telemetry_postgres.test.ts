import assert from "node:assert/strict"
import test from "node:test"

import { recordTerminal } from "../functions/momi-agent-control-dispatch-v1/src/record_terminal.ts"
import type {
  AttemptTelemetry,
  TerminalInput,
} from "../functions/momi-agent-control-dispatch-v1/src/types.ts"
import {
  acquire,
  claim,
  configure,
  reconcile,
} from "./ready_leaf_scheduler_postgres/contract.ts"
import { schedulerHarness } from "./ready_leaf_scheduler_postgres/harness.ts"

const ownerId = "10000000-0000-4000-8000-000000000099"
const threadId = "legacy-host-thread"
const turnId = "legacy-host-turn"

const persistedTelemetry = JSON.parse(JSON.stringify({
  policy_version: "execution-efficiency.v1",
  stable_prefix_fingerprint: "stable-prefix",
  context_fingerprint: "context",
  input_tokens: 1200,
  cached_input_tokens: 800,
  output_tokens: 300,
  model_visible_tool_bytes: 4096,
  model_turns: 3,
  no_progress_cycles: 0,
  subagents: 0,
  max_subagent_depth: 0,
  retries: 1,
  repeated_failure_fingerprints: 0,
  elapsed_ms: 42_000,
  disposition: "completed",
})) as AttemptTelemetry

test("a recovered legacy terminal receipt binds telemetry as one JSON object", async (context) => {
  const database = await schedulerHarness.start()
  context.after(() => schedulerHarness.stop(database))
  await configure(database.sql, "enabled")
  const candidate = await reconcile(database.sql, 999)
  const leader = await acquire(database.sql, ownerId)
  assert.ok(leader)
  const claimed = await claim(
    database.sql,
    ownerId,
    leader.fencing_generation,
    candidate,
  )
  assert.equal(claimed.claimed, true)
  assert.ok(claimed.dispatch_id)

  const [identity] = await database.sql<{ capability_token: string }[]>`
    select wake_capability_token::text as capability_token
    from momi_agent_ops.dispatches
    where dispatch_id = ${claimed.dispatch_id}::uuid
  `
  assert.ok(identity.capability_token)
  await database.sql`
    select * from momi_agent_ops.claim_dispatch_v5(
      ${claimed.dispatch_id}::uuid, ${identity.capability_token}::uuid
    )
  `
  const [accepted] = await database.sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_host_acceptance_v1(
      ${claimed.dispatch_id}::uuid, ${identity.capability_token}::uuid,
      ${threadId}, ${turnId}
    ) as recorded
  `
  assert.equal(accepted.recorded, true)

  const terminal: TerminalInput = {
    event: "terminal",
    work_id: claimed.dispatch_id,
    capability_token: identity.capability_token,
    thread_id: threadId,
    turn_id: turnId,
    readiness_result: "ready",
    terminal_disposition: "completed",
    archived_at: "2026-08-20T07:02:39.489Z",
    summary: "Recovered archived terminal receipt.",
    telemetry: persistedTelemetry,
  }

  await assert.rejects(
    recordTerminal({
      ...terminal,
      telemetry: "legacy-json-string" as unknown as AttemptTelemetry,
    }, database.sql),
    /invalid execution telemetry/,
  )
  const [afterInvalid] = await database.sql<{
    work_status: string
    telemetry_count: number
  }[]>`
    select work_status,
      (select count(*)::integer
       from momi_agent_ops.execution_attempt_telemetry telemetry
       where telemetry.dispatch_id = work.dispatch_id) as telemetry_count
    from momi_agent_ops.dispatches work
    where work.dispatch_id = ${claimed.dispatch_id}::uuid
  `
  assert.deepEqual(afterInvalid, { work_status: "writeback_pending", telemetry_count: 0 })

  assert.deepEqual(await recordTerminal(terminal, database.sql), {
    issue_id: "20000000-0000-4000-8000-000000000999",
    issue_identifier: "MOX-999",
    action: "execute-run",
    linear_comment_id: null,
  })
  assert.deepEqual(await recordTerminal(terminal, database.sql), {
    issue_id: "20000000-0000-4000-8000-000000000999",
    issue_identifier: "MOX-999",
    action: "execute-run",
    linear_comment_id: null,
  })

  const [receipt] = await database.sql<{
    work_status: string
    archive_state: string
    slot_state: string
    telemetry_count: number
    telemetry_type: string
    policy_version: string
    model_turns: number
  }[]>`
    select work.work_status, run.archive_state, slot.state as slot_state,
      count(telemetry.dispatch_id)::integer as telemetry_count,
      max(jsonb_typeof(to_jsonb(telemetry) - 'recorded_at')) as telemetry_type,
      max(telemetry.policy_version) as policy_version,
      max(telemetry.model_turns)::integer as model_turns
    from momi_agent_ops.dispatches work
    join momi_agent_ops.run_records run using (dispatch_id)
    join momi_agent_ops.scheduler_slots slot using (dispatch_id)
    left join momi_agent_ops.execution_attempt_telemetry telemetry using (dispatch_id)
    where work.dispatch_id = ${claimed.dispatch_id}::uuid
    group by work.work_status, run.archive_state, slot.state
  `
  assert.deepEqual(receipt, {
    work_status: "completed",
    archive_state: "archived",
    slot_state: "released",
    telemetry_count: 1,
    telemetry_type: "object",
    policy_version: persistedTelemetry.policy_version,
    model_turns: persistedTelemetry.model_turns,
  })
})
