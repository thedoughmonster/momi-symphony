import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("missing and ambiguous project mappings fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-mapping-"))
  try {
    const invalid = [["missing", []], ["ambiguous", [
      { linear_project_id: "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5" },
      { linear_project_id: "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5" },
    ]]] as const
    for (const [name, value] of invalid) {
      const path = join(directory, `${name}.json`)
      await writeFile(path, JSON.stringify(value))
      const result = spawnSync(process.execPath, ["scripts/check_project_mapping.ts"], {
        env: { ...process.env, SYMPHONY_PROJECT_MAPPING_FILE: path }, encoding: "utf8" })
      assert.notEqual(result.status, 0)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
