import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("development migrations use the CLI-owned short-lived login role", async () => {
  const workflow = await readFile(".github/workflows/deploy-dev.yml", "utf8")
  const operations = await readFile("docs/operations/development.md", "utf8")

  assert.doesNotMatch(workflow, /secrets\.SUPABASE_DB_PASSWORD/)
  assert.doesNotMatch(workflow, /supabase db push|migration repair/)
  assert.match(workflow, /pnpm migration:plan/)
  assert.match(workflow, /pnpm migration:apply/)
  assert.equal(
    workflow.match(/unset SUPABASE_DB_PASSWORD PGPASSWORD/g)?.length,
    3,
  )
  assert.match(operations, /Supabase CLI obtains its own short-lived login role/)
})

test("development runtime deploys can select one exact Edge Function", async () => {
  const workflow = await readFile(".github/workflows/deploy-dev.yml", "utf8")

  assert.match(workflow, /runtime_function:[\s\S]*default: all[\s\S]*- dispatch[\s\S]*- webhook/)
  assert.match(workflow,
    /if: inputs\.phase == 'runtime' && \(inputs\.runtime_function == 'all' \|\| inputs\.runtime_function == 'webhook'\)/)
  assert.match(workflow,
    /if: inputs\.phase == 'runtime' && \(inputs\.runtime_function == 'all' \|\| inputs\.runtime_function == 'dispatch'\)/)
  assert.match(workflow,
    /if: inputs\.phase != 'runtime'[\s\S]*test "\$RUNTIME_FUNCTION" = "all"/)
})
