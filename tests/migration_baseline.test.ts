import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("the seven imported development migrations remain byte-identical", async () => {
  const baseline = JSON.parse(await readFile("config/migration-baseline.json", "utf8"))
  assert.equal(Object.keys(baseline.files).length, 7)
  for (const [name, expected] of Object.entries(baseline.files)) {
    const body = await readFile(`supabase/migrations/${name}`)
    assert.equal(createHash("sha256").update(body).digest("hex"), expected)
  }
})
