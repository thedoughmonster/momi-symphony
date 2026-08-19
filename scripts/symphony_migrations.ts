import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const MIGRATION_DIRECTORY = "supabase/migrations"
const BASELINE_PATH = "config/migration-baseline.json"
const LEDGER_TABLE = "momi_agent_ops.schema_migrations"
const ADVISORY_LOCK_ID = "5570477968790471985"

type Baseline = {
  development_project_ref: string
  production_project_ref: string
  files: Record<string, string>
}

export type ManagedMigration = {
  checksum: string
  disposition: "adopted" | "applied"
  filename: string
  name: string
  sql: string
  version: string
}

export type LedgerRow = {
  checksum_sha256: string
  disposition: string
  migration_name: string
  version: string
}

export type RemoteState = {
  globalTotal: number
  globalVersions: string[]
  ledgerExists: boolean
  ledgerRows: LedgerRow[]
}

function fail(message: string): never {
  throw new Error(message)
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sqlTextArray(values: string[]): string {
  return `array[${values.map(sqlLiteral).join(", ")}]::text[]`
}

function stripSqlStringsAndComments(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/g, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/'(?:''|[^'])*'/g, "''")
}

export function validateOwnedMigrationSql(filename: string, sql: string): void {
  if (!sql.startsWith("-- service-owner: agent-control\n")) {
    fail(`${filename}: missing exact service-owner header`)
  }

  const code = stripSqlStringsAndComments(sql).toLowerCase()
  const forbidden = [
    ["security definer", /\bsecurity\s+definer\b/],
    ["transaction control", /(?:^|\n)\s*(?:begin|commit|rollback|savepoint|start\s+transaction)\s*;/m],
    ["global migration ledger", /\bsupabase_migrations\s*\./],
    ["public schema", /\bpublic\s*\./],
    ["auth schema", /\bauth\s*\./],
    ["storage schema", /\bstorage\s*\./],
    ["realtime schema", /\brealtime\s*\./],
    ["external scheduled operation", /\b(?:cron|net|vault)\s*\./],
    ["dynamic SQL", /\bexecute\b(?!\s+function\b)/],
    ["procedure call", /\bcall\b/],
  ] as const
  for (const [label, pattern] of forbidden) {
    if (pattern.test(code)) fail(`${filename}: forbidden ${label}`)
  }

  const mutationTarget = /\b(?:insert\s+into|update(?!\s+(?:set|of|on)\b)|delete\s+from|merge\s+into|truncate(?:\s+table)?|alter\s+(?:table|function|procedure|view|type|sequence)|drop\s+(?:table|function|procedure|view|type|sequence)|create\s+(?:table(?:\s+if\s+not\s+exists)?|(?:or\s+replace\s+)?(?:function|procedure|view)|type|sequence))\s+([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)?)/g
  for (const match of code.matchAll(mutationTarget)) {
    const target = match[1].replaceAll(/\s/g, "")
    if (!target.startsWith("momi_agent_ops.")) {
      fail(`${filename}: mutation target is outside momi_agent_ops`)
    }
  }
  for (const match of code.matchAll(/\bcreate\s+(?:unique\s+)?index\b[\s\S]*?\bon\s+([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)?)/g)) {
    if (!match[1].replaceAll(/\s/g, "").startsWith("momi_agent_ops.")) {
      fail(`${filename}: index target is outside momi_agent_ops`)
    }
  }
  if (/\b(?:create|alter|drop)\s+schema\b/.test(code)) {
    fail(`${filename}: schema ownership is bootstrap-only`)
  }
}

export async function loadManagedMigrations(root = process.cwd()): Promise<{
  baseline: Baseline
  migrations: ManagedMigration[]
}> {
  const baseline = JSON.parse(
    await readFile(resolve(root, BASELINE_PATH), "utf8"),
  ) as Baseline
  const entries = (await readdir(resolve(root, MIGRATION_DIRECTORY)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
  const migrations: ManagedMigration[] = []
  const versions = new Set<string>()

  for (const filename of entries) {
    const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename)
    if (!match) fail(`${filename}: invalid migration filename`)
    const [, version, name] = match
    if (versions.has(version)) fail(`${filename}: duplicate migration version`)
    versions.add(version)
    const sql = await readFile(resolve(root, MIGRATION_DIRECTORY, filename), "utf8")
    const checksum = createHash("sha256").update(sql).digest("hex")
    const expectedBaselineChecksum = baseline.files[filename]
    const disposition = expectedBaselineChecksum === undefined ? "applied" : "adopted"
    if (expectedBaselineChecksum !== undefined && checksum !== expectedBaselineChecksum) {
      fail(`${filename}: immutable baseline checksum drift`)
    }
    if (disposition === "applied") validateOwnedMigrationSql(filename, sql)
    migrations.push({ checksum, disposition, filename, name, sql, version })
  }

  const baselineNames = Object.keys(baseline.files).sort()
  if (baselineNames.length !== 7) fail("the imported baseline must contain exactly seven files")
  if (entries.slice(0, baselineNames.length).join("\n") !== baselineNames.join("\n")) {
    fail("the seven immutable baselines must be the first managed migrations")
  }
  return { baseline, migrations }
}

export function analyzeRemoteState(
  migrations: ManagedMigration[],
  state: RemoteState,
): { adoptions: ManagedMigration[]; applied: ManagedMigration[]; pending: ManagedMigration[] } {
  const expected = new Map(migrations.map((migration) => [migration.version, migration]))
  const baselines = migrations.filter((migration) => migration.disposition === "adopted")
  const futures = migrations.filter((migration) => migration.disposition === "applied")
  const globalSet = new Set(state.globalVersions)
  for (const migration of baselines) {
    if (!globalSet.has(migration.version)) {
      fail(`global history is missing imported baseline ${migration.version}`)
    }
  }
  for (const migration of futures) {
    if (globalSet.has(migration.version)) {
      fail(`global history unexpectedly owns Symphony migration ${migration.version}`)
    }
  }

  const rowVersions = new Set<string>()
  for (const row of state.ledgerRows) {
    if (rowVersions.has(row.version)) fail(`private ledger has duplicate ${row.version}`)
    rowVersions.add(row.version)
    const migration = expected.get(row.version)
    if (!migration) fail(`private ledger has unknown version ${row.version}`)
    if (
      row.checksum_sha256 !== migration.checksum ||
      row.migration_name !== migration.name ||
      row.disposition !== migration.disposition
    ) {
      fail(`private ledger metadata drift at ${row.version}`)
    }
  }

  const orderedRows = [...state.ledgerRows].sort((left, right) =>
    left.version.localeCompare(right.version),
  )
  const baselineRowCount = orderedRows.filter((row) =>
    baselines.some((migration) => migration.version === row.version),
  ).length
  if (baselineRowCount !== 0 && baselineRowCount !== baselines.length) {
    fail("private ledger contains a partial baseline adoption")
  }
  if (orderedRows.some((row) => expected.get(row.version)?.disposition === "applied") && baselineRowCount === 0) {
    fail("private ledger applied a future migration before adopting its baseline")
  }
  if (baselineRowCount === baselines.length) {
    const expectedPrefix = migrations.slice(0, orderedRows.length).map((migration) => migration.version)
    if (orderedRows.map((row) => row.version).join("\n") !== expectedPrefix.join("\n")) {
      fail("private ledger is not an ordered prefix of local migrations")
    }
  } else if (orderedRows.length !== 0) {
    fail("private ledger has out-of-order state")
  }

  const applied = futures.filter((migration) => rowVersions.has(migration.version))
  const pending = futures.filter((migration) => !rowVersions.has(migration.version))
  const adoptions = baselineRowCount === 0 ? baselines : []
  return { adoptions, applied, pending }
}

function expectedRowsSql(migrations: ManagedMigration[]): string {
  return migrations
    .map((migration) =>
      `(${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.checksum)}, ${sqlLiteral(migration.disposition)})`,
    )
    .join(",\n    ")
}

export function buildApplySql(
  migrations: ManagedMigration[],
  next: ManagedMigration,
): string {
  const baselines = migrations.filter((migration) => migration.disposition === "adopted")
  const allVersions = migrations.map((migration) => migration.version)
  const futureVersions = migrations
    .filter((migration) => migration.disposition === "applied")
    .map((migration) => migration.version)
  return `begin;
set local lock_timeout = '4s';
select pg_catalog.pg_advisory_xact_lock(${ADVISORY_LOCK_ID});

create table if not exists ${LEDGER_TABLE} (
  version text primary key check (version ~ '^[0-9]{14}$'),
  migration_name text not null check (migration_name ~ '^[a-z0-9_]+$'),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  disposition text not null check (disposition in ('adopted', 'applied')),
  applied_at timestamptz not null default now()
);
alter table ${LEDGER_TABLE} enable row level security;
revoke all on table ${LEDGER_TABLE} from public, anon, authenticated, service_role;

do $symphony_guard$
declare
  baseline_count integer;
  adopted_count integer;
begin
  select count(*) into baseline_count
  from supabase_migrations.schema_migrations
  where version = any (${sqlTextArray(baselines.map((migration) => migration.version))});
  if baseline_count <> ${baselines.length} then
    raise exception 'symphony_global_baseline_mismatch:%', baseline_count;
  end if;
  if exists (
    select 1 from supabase_migrations.schema_migrations
    where version = any (${sqlTextArray(futureVersions)})
  ) then
    raise exception 'symphony_global_history_ownership_conflict';
  end if;
  if exists (
    select 1 from ${LEDGER_TABLE}
    where not (version = any (${sqlTextArray(allVersions)}))
  ) then
    raise exception 'symphony_private_ledger_unknown_version';
  end if;
  if exists (
    select version from ${LEDGER_TABLE} group by version having count(*) <> 1
  ) then
    raise exception 'symphony_private_ledger_duplicate_version';
  end if;
  if exists (
    with expected(version, ordinal) as (
      values ${migrations.map((migration, index) => `(${sqlLiteral(migration.version)}, ${index + 1})`).join(", ")}
    ), actual as (
      select version, row_number() over (order by version) as ordinal
      from ${LEDGER_TABLE}
    )
    select 1 from actual
    left join expected using (version)
    where expected.version is null or actual.ordinal <> expected.ordinal
  ) then
    raise exception 'symphony_private_ledger_out_of_order';
  end if;
  select count(*) into adopted_count from ${LEDGER_TABLE}
  where version = any (${sqlTextArray(baselines.map((migration) => migration.version))});
  if adopted_count not in (0, ${baselines.length}) then
    raise exception 'symphony_private_ledger_partial_baseline:%', adopted_count;
  end if;
  if adopted_count = 0 and exists (
    select 1 from ${LEDGER_TABLE} where disposition = 'applied'
  ) then
    raise exception 'symphony_private_ledger_out_of_order';
  end if;
  if exists (select 1 from ${LEDGER_TABLE} where version = ${sqlLiteral(next.version)}) then
    raise exception 'symphony_private_ledger_race:${next.version}';
  end if;
end
$symphony_guard$;

insert into ${LEDGER_TABLE} (version, migration_name, checksum_sha256, disposition)
values
    ${expectedRowsSql(baselines)}
on conflict (version) do nothing;

do $symphony_checksum_guard$
begin
  if (
    select count(*) from ${LEDGER_TABLE}
    where version = any (${sqlTextArray(baselines.map((migration) => migration.version))})
  ) <> ${baselines.length} then
    raise exception 'symphony_private_ledger_baseline_adoption_failed';
  end if;
  if exists (
    with expected(version, migration_name, checksum_sha256, disposition) as (
      values
        ${expectedRowsSql(migrations)}
    )
    select 1
    from ${LEDGER_TABLE} ledger
    left join expected using (version)
    where expected.version is null
       or ledger.migration_name <> expected.migration_name
       or ledger.checksum_sha256 <> expected.checksum_sha256
       or ledger.disposition <> expected.disposition
  ) then
    raise exception 'symphony_private_ledger_checksum_or_metadata_drift';
  end if;
end
$symphony_checksum_guard$;

${next.sql.trim()}

insert into ${LEDGER_TABLE} (version, migration_name, checksum_sha256, disposition)
values (${sqlLiteral(next.version)}, ${sqlLiteral(next.name)}, ${sqlLiteral(next.checksum)}, 'applied');

commit;

select json_build_object(
  'ledger_rows', (select count(*) from ${LEDGER_TABLE}),
  'applied_version', ${sqlLiteral(next.version)},
  'global_rows', (select count(*) from supabase_migrations.schema_migrations)
) as receipt;
`
}

function sanitize(text: string): string {
  let sanitized = text
  for (const secretName of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "PGPASSWORD"]) {
    const value = process.env[secretName]
    if (value) sanitized = sanitized.replaceAll(value, "[REDACTED]")
  }
  return sanitized
    .replaceAll(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URI]")
    .replaceAll(/bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 1200)
}

async function queryLinked(sql: string): Promise<unknown[]> {
  const directory = await mkdtemp(resolve(tmpdir(), "momi-symphony-query-"))
  const file = resolve(directory, "query.sql")
  try {
    await writeFile(file, sql, { mode: 0o600 })
    const result = spawnSync(
      "pnpm",
      ["exec", "supabase", "db", "query", "--linked", "--file", file, "--output", "json", "--agent", "no"],
      { encoding: "utf8", env: process.env, maxBuffer: 1024 * 1024 },
    )
    if (result.status !== 0) {
      fail(`linked query failed: ${sanitize(result.stderr || result.stdout || "unknown error")}`)
    }
    const parsed = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(parsed)) fail("linked query returned an unexpected result shape")
    return parsed
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function parseStateCell(rows: unknown[]): Record<string, unknown> {
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    fail("linked state query returned an unexpected row count")
  }
  const state = (rows[0] as { state?: unknown }).state
  if (typeof state !== "object" || state === null) fail("linked state query omitted state")
  return state as Record<string, unknown>
}

async function readRemoteState(migrations: ManagedMigration[]): Promise<RemoteState> {
  const state = parseStateCell(await queryLinked(`
select json_build_object(
  'global_total', (select count(*) from supabase_migrations.schema_migrations),
  'global_versions', coalesce((
    select json_agg(version order by version)
    from supabase_migrations.schema_migrations
    where version = any (${sqlTextArray(migrations.map((migration) => migration.version))})
  ), '[]'::json),
  'ledger_exists', to_regclass('${LEDGER_TABLE}') is not null
) as state;
`))
  const ledgerExists = state.ledger_exists === true
  const ledgerRows = ledgerExists
    ? await queryLinked(`
select version, migration_name, checksum_sha256, disposition
from ${LEDGER_TABLE}
order by version;
`) as LedgerRow[]
    : []
  return {
    globalTotal: Number(state.global_total),
    globalVersions: Array.isArray(state.global_versions)
      ? state.global_versions.map(String)
      : fail("global migration versions are malformed"),
    ledgerExists,
    ledgerRows,
  }
}

async function assertRemoteBoundary(baseline: Baseline, root: string): Promise<void> {
  const selected = process.env.SUPABASE_DEV_PROJECT_REF
  if (selected !== baseline.development_project_ref || selected === baseline.production_project_ref) {
    fail("SUPABASE_DEV_PROJECT_REF is not the pinned development project")
  }
  if (process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD) {
    fail("managed database password variables must be absent")
  }
  if (!process.env.SUPABASE_ACCESS_TOKEN) fail("SUPABASE_ACCESS_TOKEN is required")
  const linked = (await readFile(resolve(root, "supabase/.temp/project-ref"), "utf8")).trim()
  if (linked !== baseline.development_project_ref) fail("linked project ref is not pinned development")
}

async function main(): Promise<void> {
  const operation = process.argv[2]
  if (operation !== "plan" && operation !== "apply") {
    fail("usage: node scripts/symphony_migrations.ts <plan|apply>")
  }
  const root = process.cwd()
  const { baseline, migrations } = await loadManagedMigrations(root)
  await assertRemoteBoundary(baseline, root)
  const state = await readRemoteState(migrations)
  const plan = analyzeRemoteState(migrations, state)
  console.log(
    `symphony-ledger plan global=${state.globalTotal} adopted=${migrations.filter((migration) => migration.disposition === "adopted").length - plan.adoptions.length} pending_adoptions=${plan.adoptions.length} applied=${plan.applied.length} pending=${plan.pending.map((migration) => migration.version).join(",") || "none"}`,
  )
  if (operation === "plan") return
  if (plan.pending.length === 0) {
    console.log("symphony-ledger apply no-op")
    return
  }
  if (plan.pending.length !== 1) fail("apply requires exactly one pending Symphony migration")
  const receipt = await queryLinked(buildApplySql(migrations, plan.pending[0]))
  if (receipt.length !== 1) fail("apply returned an unexpected receipt")
  console.log(`symphony-ledger applied=${plan.pending[0].version}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(sanitize(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}

export const migrationLedgerContract = {
  advisoryLockId: ADVISORY_LOCK_ID,
  ledgerTable: LEDGER_TABLE,
}
