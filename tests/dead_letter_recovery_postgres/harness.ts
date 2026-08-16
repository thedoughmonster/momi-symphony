import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"

import postgres, { type Sql } from "postgres"

export type RecoveryDatabase = { container: string; sql: Sql }

const migrationUrl = new URL(
  "../../../../supabase/migrations/20260816183827_add_agent_control_dead_letter_recovery.sql",
  import.meta.url,
)

export const recoveryHarness = {
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
    create schema momi_agent_ops;
    create table momi_agent_ops.project_mappings (
      linear_project_id uuid primary key, repository text not null,
      base_branch text not null, active boolean not null,
      host_dispatch_url text
    );
    create table momi_agent_ops.dispatches (
      dispatch_id uuid primary key, linear_issue_identifier text not null,
      linear_project_id uuid, action text not null, mapped_repository text,
      mapped_base_branch text, rejection_code text, work_status text not null,
      attempt_count integer not null, next_attempt_at timestamptz not null,
      lease_expires_at timestamptz, capability_token_hash text not null,
      host_callback_token_hash text, wake_capability_token uuid,
      codex_thread_id text, codex_turn_id text, last_error_code text,
      claimed_at timestamptz, host_accepted_at timestamptz,
      completed_at timestamptz, cancellation_state text not null,
      recovery_state text not null
    );
    create table momi_agent_ops.run_records (
      dispatch_id uuid primary key references momi_agent_ops.dispatches,
      readiness_result text not null, linear_comment_id uuid,
      action_label_removed_at timestamptz, execute_run_removed_at timestamptz,
      has_run_added_at timestamptz, linear_writeback_at timestamptz,
      terminal_disposition text, terminal_at timestamptz,
      archive_state text not null, archived_at timestamptz
    );
    `)
    await sql.unsafe(await readFile(migrationUrl, "utf8"))
  },
  async start(): Promise<RecoveryDatabase> {
    const container = `momi-agent-recovery-${process.pid}-${Date.now()}`
    let sql: Sql | null = null
    try {
      recoveryHarness.docker(["run", "--detach", "--rm", "--name", container,
        "--env", "POSTGRES_PASSWORD=momi-agent-test",
        "--publish", "127.0.0.1::5432", "postgres:17-alpine"])
      const port = Number(recoveryHarness.docker(
        ["port", container, "5432/tcp"],
      ).match(/:(\d+)$/)?.[1])
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        sql = postgres(`postgres://postgres:momi-agent-test@127.0.0.1:${port}/postgres`,
          { connect_timeout: 2, max: 4, prepare: false })
        try { await sql`select 1`; break } catch {
          await sql.end({ timeout: 1 }).catch(() => undefined)
          sql = null
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      if (!sql) throw new Error("Disposable PostgreSQL did not start")
      await recoveryHarness.prepare(sql)
      return { container, sql }
    } catch (error) {
      await sql?.end({ timeout: 1 }).catch(() => undefined)
      spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" })
      throw error
    }
  },
  async stop(database: RecoveryDatabase): Promise<void> {
    await database.sql.end({ timeout: 2 }).catch(() => undefined)
    spawnSync("docker", ["rm", "-f", database.container], { encoding: "utf8" })
  },
}
