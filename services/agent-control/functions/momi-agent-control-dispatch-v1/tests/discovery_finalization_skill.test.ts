import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const skillPath = ".agents/skills/linear-finalize-discovery/SKILL.md"
const metadataPath = ".agents/skills/linear-finalize-discovery/agents/openai.yaml"

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
  assert.match(source, /current user message clearly requests finalization into\nLinear/)
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
  assert.match(source, /Set each leaf's native\n`parentId`/)
  assert.match(source, /Add only missing native `blockedBy` relations/)
  assert.match(source, /requirements and decisions in the body[\s\S]*hierarchy and dependencies in\nnative fields/)
  assert.match(source, /After every write, read the affected issue with relations and verify identity/)
  assert.match(source, /one identity per desired\nnode and one copy of each relation/)
})

test("MOX-230 readiness and report categories are complete", async () => {
  const source = await skill()
  for (const requirement of ["Implementation", "ready-package", "## Acceptance criteria",
    "needs-discovery", "blocked-external-decision", "status type `completed`"]) {
    assert.match(source, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  assert.match(source, /Parents\nwith sub-issues are never executable leaves and never receive `ready-package`/)
  assert.match(source, /Keep dependency-blocked, freeze-blocked,[\s\S]*in `Backlog` with readiness false/)
  for (const category of ["created", "updated", "reused", "ready", "dependency-blocked",
    "freeze-blocked", "unresolved"]) assert.ok(source.includes(`- \`${category}\``))
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
