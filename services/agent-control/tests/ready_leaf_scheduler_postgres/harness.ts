import { spawnSync } from "node:child_process"

import postgres, { type Sql } from "postgres"

import { loadManagedMigrations } from "../../../../scripts/symphony_migrations.ts"

export type SchedulerDatabase = { container: string; sql: Sql; url: string }

export const schedulerHarness = {
  docker(args: string[]): string {
    const result = spawnSync("docker", args, {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr.trim())
    return result.stdout.trim()
  },
  async prepare(sql: Sql): Promise<void> {
    await sql.unsafe(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'anon') then
          create role anon nologin;
        end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin;
        end if;
        if not exists (select from pg_roles where rolname = 'service_role') then
          create role service_role nologin;
        end if;
      end $$;
      create schema extensions;
      create extension pgcrypto with schema extensions;
      create schema vault;
      create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
      create schema net;
      create function net.http_post(
        url text, headers jsonb, body jsonb, timeout_milliseconds integer
      ) returns bigint language sql as 'select 1::bigint';
      create schema cron;
      create function cron.schedule(name text, schedule text, command text)
      returns bigint language sql as 'select 1::bigint';
    `)
    const { migrations } = await loadManagedMigrations()
    for (const migration of migrations.slice(0, 7)) await sql.unsafe(migration.sql)
    await sql`
      update momi_agent_ops.project_mappings
      set host_dispatch_url = 'https://host.example/v1/dispatch'
      where linear_project_name = 'Backend Stabilization'
    `
    for (const migration of migrations.slice(7)) await sql.unsafe(migration.sql)
  },
  async start(): Promise<SchedulerDatabase> {
    const container = `momi-ready-leaf-${process.pid}-${Date.now()}`
    let sql: Sql | null = null
    try {
      schedulerHarness.docker(["run", "--detach", "--rm", "--name", container,
        "--env", "POSTGRES_PASSWORD=momi-agent-test",
        "--publish", "127.0.0.1::5432", "postgres:17-alpine"])
      const port = Number(schedulerHarness.docker(
        ["port", container, "5432/tcp"],
      ).match(/:(\d+)$/)?.[1])
      const connection = new URL(`postgres://postgres@127.0.0.1:${port}/postgres`)
      connection.password = "momi-agent-test"
      const url = connection.href
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        sql = postgres(url, { connect_timeout: 2, max: 24, prepare: false })
        try { await sql`select 1`; break } catch {
          await sql.end({ timeout: 1 }).catch(() => undefined)
          sql = null
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      if (!sql) throw new Error("Disposable PostgreSQL did not start")
      await schedulerHarness.prepare(sql)
      return { container, sql, url }
    } catch (error) {
      await sql?.end({ timeout: 1 }).catch(() => undefined)
      spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" })
      throw error
    }
  },
  async stop(database: SchedulerDatabase): Promise<void> {
    await database.sql.end({ timeout: 2 }).catch(() => undefined)
    spawnSync("docker", ["rm", "-f", database.container], { encoding: "utf8" })
  },
}
