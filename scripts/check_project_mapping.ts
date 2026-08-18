import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const path = process.env.SYMPHONY_PROJECT_MAPPING_FILE ?? "config/project-mappings.json"
const mappings = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>
const expected = mappings.filter((mapping) =>
  mapping.linear_project_id === "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5")
assert.equal(expected.length, 1, "mapping must exist exactly once")
assert.deepEqual(expected[0], {
  linear_project_id: "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5",
  linear_project_name: "Symphony Control Plane",
  repository: "thedoughmonster/momi-symphony",
  base_branch: "main",
  active_states: ["Todo", "In Progress", "Rework"],
  active: true,
})
