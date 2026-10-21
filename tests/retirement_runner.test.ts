import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { assertRetirementContext, executeRetirement, retirementClientTimeoutMs } from "../scripts/retire_dispatch_trigger.ts"
import { retirementMigration, retirementSqlSha256 } from "../scripts/retirement_sql.ts"

const environment = {
  SUPABASE_DEV_PROJECT_REF: "xtbraqnlskmqxinjxxdn", SUPABASE_ACCESS_TOKEN: "synthetic-token",
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "thedoughmonster/momi-symphony",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: "thedoughmonster/momi-symphony/.github/workflows/deploy-dev.yml@refs/heads/main",
  GITHUB_SHA: "a".repeat(40), RETIREMENT_COMMIT: "a".repeat(40),
}

test("retirement rejects every non-owner, non-main, credential, and target mismatch", () => {
  assert.equal(assertRetirementContext(environment, environment.SUPABASE_DEV_PROJECT_REF), environment.GITHUB_SHA)
  for (const change of [
    { SUPABASE_DEV_PROJECT_REF: "another-project" }, { SUPABASE_PROJECT_ID: "another-project" },
    { SUPABASE_PROJECT_ID: "" }, { SUPABASE_ACCESS_TOKEN: "" },
    { SUPABASE_DB_PASSWORD: "synthetic-password" }, { PGPASSWORD: "synthetic-password" },
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "fixture/other" },
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/other" },
    { GITHUB_WORKFLOW_REF: "fixture/other/.github/workflows/deploy-dev.yml@refs/heads/main" },
    { RETIREMENT_COMMIT: "b".repeat(40) }, { RETIREMENT_COMMIT: "main" },
  ]) assert.throws(() => assertRetirementContext({ ...environment, ...change }, environment.SUPABASE_DEV_PROJECT_REF))
  assert.throws(() => assertRetirementContext(environment, "another-project"))
})

test("retirement runs one bounded fixed query and never retries uncertain results", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "retirement-runner-test-"))
  context.after(async () => {
    await unlink(resolve(root, "supabase/.temp/project-ref"))
    await unlink(resolve(root, "supabase/migrations", retirementMigration))
    await rmdir(resolve(root, "supabase/.temp"))
    await rmdir(resolve(root, "supabase/migrations"))
    await rmdir(resolve(root, "supabase"))
    await rmdir(root)
  })
  await mkdir(resolve(root, "supabase/.temp"), { recursive: true })
  await mkdir(resolve(root, "supabase/migrations"), { recursive: true })
  await writeFile(resolve(root, "supabase/.temp/project-ref"), environment.SUPABASE_DEV_PROJECT_REF)
  await writeFile(resolve(root, "supabase/migrations", retirementMigration),
    await readFile(`supabase/migrations/${retirementMigration}`))
  let calls = 0
  let queryFile = ""
  const cases = [
    { status: 0, stdout: JSON.stringify([{ trigger_disabled: true, other_triggers_preserved: true, ignored: "synthetic-private-detail" }]), succeeds: true },
    { status: 1, stdout: "synthetic-token", succeeds: false },
    { status: null, stdout: "", error: new Error("synthetic-timeout"), succeeds: false },
    { status: 0, stdout: "not-json-synthetic-private-detail", succeeds: false },
    { status: 0, stdout: JSON.stringify([{ trigger_disabled: true, other_triggers_preserved: false }]), succeeds: false },
    { status: 0, stdout: "[]", succeeds: false },
  ]
  for (const result of cases) {
    const run = ((command, args, options) => {
      calls += 1
      assert.equal(command, "pnpm")
      queryFile = args![args!.indexOf("--file") + 1]
      assert.deepEqual(args, ["exec", "supabase", "db", "query", "--linked", "--file", queryFile, "--output", "json", "--agent", "no"])
      assert.equal(options!.timeout, retirementClientTimeoutMs)
      assert.equal(options!.killSignal, "SIGTERM")
      assert.equal(options!.cwd, root)
      assert.equal(options!.env?.SUPABASE_PROJECT_ID, environment.SUPABASE_DEV_PROJECT_REF)
      const query = readFileSync(queryFile, "utf8")
      assert.match(query, /disable trigger dispatch_agent_control_work/)
      assert.doesNotMatch(query, /schema_migrations|migration:apply|functions deploy/)
      return { ...result, stderr: "synthetic-token", signal: null, pid: 1, output: [] }
    }) as typeof spawnSync
    const countBefore = calls
    if (result.succeeds) {
      assert.deepEqual(await executeRetirement(root, environment, run), {
        commit: environment.GITHUB_SHA, sql_sha256: retirementSqlSha256,
        trigger_disabled: true, other_triggers_preserved: true,
      })
    } else {
      await assert.rejects(executeRetirement(root, environment, run),
        /^Error: retirement_(outcome|receipt)_unconfirmed_readback_required$/)
    }
    assert.equal(calls, countBefore + 1)
    await assert.rejects(readFile(queryFile), { code: "ENOENT" })
  }
  await writeFile(resolve(root, "supabase/.temp/project-ref"), "another-project")
  const countBefore = calls
  await assert.rejects(executeRetirement(root, environment, (() => { calls += 1 }) as unknown as typeof spawnSync), /development_target_required/)
  assert.equal(calls, countBefore)
})
