import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("retirement is an exact-commit protected phase with no migration or runtime step", async () => {
  const workflow = await readFile(".github/workflows/deploy-dev.yml", "utf8")
  assert.match(workflow, /options:[\s\S]*- retirement/)
  const jobGuard = workflow.slice(workflow.indexOf("jobs:"), workflow.indexOf("    steps:"))
  assert.match(jobGuard, /inputs\.commit == github\.sha &&/)
  assert.match(jobGuard, /inputs\.phase != 'retirement' \|\|/)
  assert.match(jobGuard, /github\.repository == 'thedoughmonster\/momi-symphony'/)
  assert.match(jobGuard, /github\.ref == 'refs\/heads\/main'/)
  assert.match(jobGuard, /github\.event_name == 'workflow_dispatch'/)
  assert.match(jobGuard, /environment: development/)
  assert.match(workflow, /permissions:\s+contents: read/)
  assert.match(workflow, /group: momi-symphony-development\s+cancel-in-progress: false/)
  const steps = workflow.split(/\n      - name: /)
  const retirement = steps.find((step) => step.startsWith("Retire only the reviewed dispatch wake trigger"))!
  assert.match(retirement, /if: inputs\.phase == 'retirement'/)
  assert.match(retirement, /unset SUPABASE_DB_PASSWORD PGPASSWORD/)
  assert.match(retirement, /node scripts\/retire_dispatch_trigger\.ts/)
  assert.match(retirement, /RETIREMENT_COMMIT: \$\{\{ inputs\.commit \}\}/)
  assert.doesNotMatch(retirement, /migration:|functions deploy|host health|curl/)
  for (const step of steps.filter((step) => /pnpm migration:plan/.test(step))) {
    assert.match(step, /if: inputs\.phase == 'preflight' \|\| inputs\.phase == 'mapping'/)
  }
  for (const step of steps.filter((step) => /pnpm migration:apply/.test(step))) {
    assert.match(step, /if: inputs\.phase == 'mapping'/)
  }
  for (const step of steps.filter((step) => /functions deploy/.test(step))) {
    assert.match(step, /if: inputs\.phase == 'runtime'/)
  }
})
