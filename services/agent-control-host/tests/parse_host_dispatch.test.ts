import assert from "node:assert/strict"
import test from "node:test"

import { parseHostDispatch } from "../src/parse_host_dispatch.ts"

const base = { work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  issue_id: "00000000-0000-4000-8000-000000000003", issue_identifier: "MOX-159",
  issue_url: "https://linear.app/x/issue/MOX-159/x",
  project_id: "00000000-0000-4000-8000-000000000004",
  project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
  base_branch: "main", active_states: ["In Progress"],
  instruction: "Ask one concise discovery question and remain available for follow-up." }

test("normalizes legacy one-shot dispatches and accepts strict interactive v2", () => {
  const legacy = parseHostDispatch({ schema_version: 1, ...base })
  assert.equal(legacy?.interaction_mode, "one_shot")
  assert.equal(legacy?.thread_name, "MOX-159 · agent run")
  const interactive = parseHostDispatch({ schema_version: 2, ...base,
    interaction_mode: "interactive", thread_name: "MOX-159 · interactive discovery" })
  assert.equal(interactive?.interaction_mode, "interactive")
  assert.equal(interactive?.thread_name, "MOX-159 · interactive discovery")
  assert.equal(parseHostDispatch({ schema_version: 2, ...base,
    interaction_mode: "interactive", thread_name: "MOX-159", extra: true }), null)
  assert.equal(parseHostDispatch({ schema_version: "2", ...base,
    interaction_mode: "interactive", thread_name: "MOX-159" }), null)
})
