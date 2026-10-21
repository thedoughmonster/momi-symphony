import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { buildRetirementSql, retirementMigration, retirementSqlSha256 } from "./retirement_sql.ts"

const developmentProject = "xtbraqnlskmqxinjxxdn"
export const retirementClientTimeoutMs = 60_000

export function assertRetirementContext(env: NodeJS.ProcessEnv, linked: string): string {
  if (env.SUPABASE_DEV_PROJECT_REF !== developmentProject || linked.trim() !== developmentProject
    || (env.SUPABASE_PROJECT_ID !== undefined && env.SUPABASE_PROJECT_ID !== developmentProject)) {
    throw new Error("retirement_development_target_required")
  }
  if (env.SUPABASE_DB_PASSWORD || env.PGPASSWORD || !env.SUPABASE_ACCESS_TOKEN) {
    throw new Error("retirement_existing_token_only")
  }
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "thedoughmonster/momi-symphony"
    || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_WORKFLOW_REF !== "thedoughmonster/momi-symphony/.github/workflows/deploy-dev.yml@refs/heads/main"
    || !/^[0-9a-f]{40}$/.test(env.RETIREMENT_COMMIT ?? "")
    || env.RETIREMENT_COMMIT !== env.GITHUB_SHA) {
    throw new Error("retirement_exact_main_workflow_required")
  }
  return env.RETIREMENT_COMMIT!
}

export async function executeRetirement(
  root: string, env: NodeJS.ProcessEnv, run: typeof spawnSync = spawnSync,
): Promise<{ commit: string; sql_sha256: string; trigger_disabled: true; other_triggers_preserved: true }> {
  const linked = await readFile(resolve(root, "supabase/.temp/project-ref"), "utf8")
  const commit = assertRetirementContext(env, linked)
  const sql = buildRetirementSql(await readFile(resolve(root, "supabase/migrations", retirementMigration), "utf8"))
  const directory = await mkdtemp(resolve(tmpdir(), "momi-retirement-"))
  const file = resolve(directory, "retirement.sql")
  try {
    await writeFile(file, sql, { mode: 0o600 })
    const result = run("pnpm", ["exec", "supabase", "db", "query", "--linked", "--file", file,
      "--output", "json", "--agent", "no"], {
      cwd: root, env: { ...env, SUPABASE_PROJECT_ID: developmentProject },
      encoding: "utf8", maxBuffer: 1024 * 1024,
      timeout: retirementClientTimeoutMs, killSignal: "SIGTERM",
    })
    // Never emit CLI output: errors may contain operational details or secrets.
    // A timeout can follow a commit; it is uncertain, never an automatic retry.
    if (result.error || result.status !== 0) throw new Error("retirement_outcome_unconfirmed_readback_required")
    let rows: unknown
    try { rows = JSON.parse(String(result.stdout)) } catch {
      throw new Error("retirement_receipt_unconfirmed_readback_required")
    }
    if (!Array.isArray(rows) || rows.length !== 1
      || rows[0]?.trigger_disabled !== true || rows[0]?.other_triggers_preserved !== true) {
      throw new Error("retirement_receipt_unconfirmed_readback_required")
    }
    return { commit, sql_sha256: retirementSqlSha256, trigger_disabled: true, other_triggers_preserved: true }
  } finally {
    try {
      await unlink(file)
      await rmdir(directory)
    } catch {
      throw new Error("retirement_cleanup_unconfirmed_readback_required")
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
  executeRetirement(process.cwd(), process.env).then((receipt) => {
    console.log(JSON.stringify({ operation: "retire_dispatch_wake_trigger", ...receipt }))
  }).catch(() => {
    console.error("Retirement not confirmed. Inspect the exact trigger using the authorized read-only route before retrying; no automatic retry was made.")
    process.exitCode = 1
  })
}
