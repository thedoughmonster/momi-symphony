import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createLinearAdapterProfile,
  normalizeLinearIssue,
} from "../src/linear_issue_adapter.ts"
import { schedulerEligibility } from "../../../src/scheduler_policy.ts"

const skillPath = ".agents/skills/linear-finalize-discovery/SKILL.md"
const metadataPath = ".agents/skills/linear-finalize-discovery/agents/openai.yaml"
const projectMappingPath = "config/project-mappings.json"
const schedulerMigrationPath = "supabase/migrations/20260819045838_add_ready_leaf_scheduler.sql"
const readinessMigrationPath =
  "supabase/migrations/20260828190000_simplify_readiness_and_decouple_projection.sql"

async function skill(): Promise<string> {
  return await readFile(skillPath, "utf8")
}

function assertOrdered(source: string, fragments: string[]): void {
  let position = -1
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, position + 1)
    assert.notEqual(next, -1, `missing ordered contract fragment: ${fragment}`)
    assert.ok(next > position, `out-of-order contract fragment: ${fragment}`)
    position = next
  }
}

test("skill trigger accepts explicit finalization and rejects inferred intent", async () => {
  const source = await skill()
  assert.match(source, /current user message clearly requests finalization into\r?\nLinear/)
  assert.match(source, /Finalize this discovery into Linear/)
  assert.match(source, /If intent is ambiguous, ask one concise clarification and make no write/)
  for (const negative of ["quiet conversation", "elapsed time", "turn completion",
    "task retention", "task archive"]) assert.match(source, new RegExp(negative))
})

test("skill encodes search-before-create, replay, and ambiguous-write stops", async () => {
  const source = await skill()
  assertOrdered(source, [
    "## 1. Re-read the bounded source of truth",
    "## 2. Form the minimum desired graph",
    "## 3. Resolve identity before every create",
    "## 4. Preserve content and write native planning",
    "## 5. Apply MOX-230 readiness conservatively",
    "## 6. Read back and prove convergence",
    "## 7. Return the compact durable report",
  ])
  assert.match(source, /zero plausible matches permits one create/)
  assert.match(source, /one plausible match requires reuse/)
  assert.match(source, /more than one plausible match is ambiguous: stop before creating/)
  assert.match(source, /never retry the write blindly/)
  assert.match(source, /stop before the affected write and report missing authority/)
  assert.match(source, /On exact replay[\s\S]*create nothing[\s\S]*report the converged nodes as `reused`/)
})

test("golden native graph requires preservation, relations, and exact readback", async () => {
  const source = await skill()
  assert.match(source, /preserve its identifier[\s\S]*all unrelated human-authored description/)
  assert.match(source, /Set each leaf's native\r?\n`parentId`/)
  assert.match(source, /Add only missing native `blockedBy` relations/)
  assert.match(source, /requirements and decisions in the body[\s\S]*hierarchy and dependencies in\r?\nnative fields/)
  assert.match(source, /After every write, read the affected issue with relations and verify identity/)
  assert.match(source, /one identity per desired\r?\nnode and one copy of each relation/)
})

test("minimal readiness and report categories are complete", async () => {
  const source = await skill()
  for (const requirement of ["ready-package", "exact project/repository/base mapping",
    "active mapped state", "every native blocker has status type `completed`"]) {
    assert.match(source, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  assert.match(source, /Complete leaf, no freeze, any blocker non-completed \| `Todo` \| `ready-package` \| `dependency-blocked`/)
  for (const nonReady of ["Structurally incomplete leaf",
    "Leaf with an unresolved material decision",
    "Leaf under a current freeze/baseline gate",
    "Parent or any node with a direct sub-issue"]) {
    assert.ok(source.includes(`| ${nonReady} | \`Backlog\` |`), nonReady)
  }
  for (const category of ["created", "updated", "reused", "ready", "dependency-blocked",
    "freeze-blocked", "unresolved"]) assert.ok(source.includes(`- \`${category}\``))
})

test("mixed finalized graph keeps ready, blocked, and excluded nodes distinct", async () => {
  const source = await skill()
  const fixtures = [
    ["Complete leaf, no freeze, every blocker completed", "`Todo`",
      "`ready-package`", "`ready`"],
    ["Complete leaf, no freeze, any blocker non-completed", "`Todo`",
      "`ready-package`", "`dependency-blocked`"],
    ["Structurally incomplete leaf", "`Backlog`",
      "never `ready-package`", "`unresolved`"],
    ["Leaf with an unresolved material decision", "`Backlog`",
      "never `ready-package`", "`unresolved`"],
    ["Leaf under a current freeze/baseline gate", "`Backlog`",
      "never `ready-package`", "`freeze-blocked`"],
    ["Parent or any node with a direct sub-issue", "`Backlog`",
      "never `ready-package`", "not a ready leaf"],
  ]
  for (const fixture of fixtures) {
    assert.ok(source.includes(`| ${fixture.join(" | ")} |`), fixture[0])
  }
  const categories = [...source.matchAll(/^- `([a-z-]+)`: /gm)]
    .map((match) => match[1])
  assert.deepEqual(categories, ["created", "updated", "reused", "ready",
    "dependency-blocked", "freeze-blocked", "unresolved"])
})

test("finalizer state and labels converge with scheduler blocker handling", async () => {
  const source = await skill()
  const declared = source.match(
    /exact finalization-ready package is state\r?\n`([^`]+)` with label `([^`]+)`/,
  )
  assert.ok(declared, "skill must declare one exact finalizer/scheduler package")
  const [, readyState, readinessLabel] = declared
  const mappings = JSON.parse(await readFile(projectMappingPath, "utf8")) as Array<{
    linear_project_id: string
    repository: string
    base_branch: string
    active_states: string[]
  }>
  const mapping = mappings.find((candidate) =>
    candidate.linear_project_id === "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5")
  assert.ok(mapping)
  assert.equal(mapping.active_states[0], readyState)
  assert.match(await readFile(schedulerMigrationPath, "utf8"),
    /required_labels text\[\] not null/)
  const readinessMigration = await readFile(readinessMigrationPath, "utf8")
  const required = readinessMigration.match(
    /required_labels set default array\['([^']+)'\]::text\[\]/,
  )
  assert.ok(required)
  const requiredLabels = required.slice(1)
  assert.deepEqual(requiredLabels, [readinessLabel.toLowerCase()])

  const payload = {
    id: "leaf-b",
    identifier: "MOX-252",
    title: "Dependent leaf",
    description: "## Acceptance criteria\n\n- The dependent completes.",
    priority: 2,
    url: "https://linear.app/mox/issue/MOX-252/dependent-leaf",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T01:00:00.000Z",
    state: { id: "todo", name: readyState, type: "unstarted" },
    project: { id: mapping.linear_project_id },
    team: { id: "team-1" },
    labels: { nodes: [
      { id: "ready", name: readinessLabel },
    ], pageInfo: { hasNextPage: false, endCursor: null } },
    parent: { id: "parent", identifier: "MOX-250",
      state: { id: "backlog", name: "Backlog", type: "backlog" } },
    children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    inverseRelations: { nodes: [{ type: "blocks", issue: {
      id: "leaf-a", identifier: "MOX-251",
      state: { id: "started", name: "In Progress", type: "started" },
    } }], pageInfo: { hasNextPage: false, endCursor: null } },
  }
  const profile = createLinearAdapterProfile({ projectId: mapping.linear_project_id,
    teamId: "team-1", repository: mapping.repository, baseBranch: mapping.base_branch })
  assert.deepEqual([...profile.readinessLabels], requiredLabels)
  const policy = { activeStates: mapping.active_states, requiredLabels }
  const blocked = normalizeLinearIssue(payload, profile)
  assert.equal(blocked.state, readyState)
  assert.deepEqual(blocked.labels, [readinessLabel])
  assert.deepEqual(blocked.dispatchability_reasons, ["blocker_not_accepted"])
  assert.deepEqual(schedulerEligibility(blocked, policy), {
    eligible: false, reason: "adapter_unroutable",
  })

  const completedPayload = structuredClone(payload)
  completedPayload.inverseRelations.nodes[0].issue.state = {
    id: "done", name: "Done", type: "completed",
  }
  const unblocked = normalizeLinearIssue(completedPayload, profile)
  assert.equal(unblocked.state, blocked.state)
  assert.deepEqual(unblocked.labels, blocked.labels)
  assert.equal(unblocked.dispatchable, true)
  assert.deepEqual(schedulerEligibility(unblocked, policy), {
    eligible: true, reason: "eligible",
  })
})

test("finalization has a Linear-only capability boundary and valid metadata", async () => {
  const source = await skill()
  assert.match(source, /Use only native Linear search/)
  for (const prohibited of ["shell or git", "filesystem", "GitHub", "repository/branch/worktree/commit/PR",
    "validation", "agent/thread/task", "execution action label", "dispatch", "merge", "release",
    "deploy"]) assert.match(source, new RegExp(prohibited.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(source, /Never add `execute-run`/)
  const metadata = await readFile(metadataPath, "utf8")
  assert.match(metadata, /display_name: "Finalize Linear Discovery"/)
  assert.match(metadata, /default_prompt: "Use \$linear-finalize-discovery/)
  assert.doesNotMatch(source + metadata, /TODO/)
})
