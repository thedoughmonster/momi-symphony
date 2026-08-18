import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import postgres, { type Sql } from "postgres"

import { buildApplySql, loadManagedMigrations } from "../../scripts/symphony_migrations.ts"

function docker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim())
  return result.stdout.trim()
}

async function connect(container: string): Promise<Sql> {
  const port = Number(docker(["port", container, "5432/tcp"]).match(/:(\d+)$/)?.[1])
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const sql = postgres(`postgres://postgres:momi-agent-test@127.0.0.1:${port}/postgres`, {
      connect_timeout: 2, max: 2, prepare: false,
    })
    try {
      await sql`select 1`
      return sql
    } catch {
      await sql.end({ timeout: 1 }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error("Disposable PostgreSQL did not start")
}

test("the private ledger applies atomically without changing global history", async (context) => {
  const container = `momi-symphony-ledger-${process.pid}-${Date.now()}`
  docker(["run", "--detach", "--rm", "--name", container,
    "--env", "POSTGRES_PASSWORD=momi-agent-test",
    "--publish", "127.0.0.1::5432", "postgres:17-alpine"])
  const sql = await connect(container)
  context.after(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined)
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" })
  })

  const { migrations } = await loadManagedMigrations()
  const baselines = migrations.slice(0, 7)
  const mapping = migrations[7]
  const unrelated = Array.from({ length: 267 }, (_, index) => String(20_000_000_000_000 + index))

  await sql.unsafe(`
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key);
    create schema momi_agent_ops;
    create table momi_agent_ops.project_mappings (
      linear_project_id uuid primary key,
      linear_project_name text not null,
      repository text not null,
      base_branch text not null,
      active_states text[] not null,
      active boolean not null,
      host_dispatch_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    insert into momi_agent_ops.project_mappings (
      linear_project_id, linear_project_name, repository, base_branch,
      active_states, active, host_dispatch_url
    ) values (
      'a7932d3c-82c7-477b-9942-3ccaf7a39d06', 'Backend Stabilization',
      'thedoughmonster/momi-backend', 'dev', array['Todo'], true,
      'https://private.example.invalid/dispatch'
    );
  `)
  await sql`insert into supabase_migrations.schema_migrations ${sql(
    [...unrelated, ...baselines.map((migration) => migration.version)].map((version) => ({ version })),
  )}`

  const forcedFailure = { ...mapping, sql: "-- service-owner: agent-control\nselect 1 / 0;\n" }
  await assert.rejects(sql.unsafe(buildApplySql(migrations, forcedFailure)), /division by zero/)
  await sql.unsafe("rollback")
  const afterFailure = await sql<{ ledger: string | null }[]>`
    select to_regclass('momi_agent_ops.schema_migrations')::text as ledger
  `
  assert.equal(afterFailure[0].ledger, null)

  await sql.unsafe(buildApplySql(migrations, mapping))
  const [receipt] = await sql<{
    active_mapping: number
    global_rows: number
    ledger_rows: number
    rls_enabled: boolean
  }[]>`
    select
      (select count(*)::int from momi_agent_ops.project_mappings
       where repository = 'thedoughmonster/momi-symphony' and active) as active_mapping,
      (select count(*)::int from supabase_migrations.schema_migrations) as global_rows,
      (select count(*)::int from momi_agent_ops.schema_migrations) as ledger_rows,
      (select relrowsecurity from pg_class
       where oid = 'momi_agent_ops.schema_migrations'::regclass) as rls_enabled
  `
  assert.deepEqual(receipt, {
    active_mapping: 1,
    global_rows: 274,
    ledger_rows: 8,
    rls_enabled: true,
  })
  await assert.rejects(sql.unsafe(buildApplySql(migrations, mapping)), /ledger_race/)
})
