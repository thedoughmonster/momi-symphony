import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("development migrations use the CLI-owned short-lived login role", async () => {
  const workflow = await readFile(".github/workflows/deploy-dev.yml", "utf8")
  const operations = await readFile("docs/operations/development.md", "utf8")

  assert.doesNotMatch(workflow, /secrets\.SUPABASE_DB_PASSWORD/)
  assert.equal(
    workflow.match(/unset SUPABASE_DB_PASSWORD PGPASSWORD/g)?.length,
    3,
  )
  assert.match(operations, /Supabase CLI obtains its own short-lived login role/)
})
