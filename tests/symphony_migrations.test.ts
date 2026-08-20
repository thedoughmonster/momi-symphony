import assert from "node:assert/strict"
import test from "node:test"

import {
  analyzeRemoteState,
  buildApplySql,
  loadManagedMigrations,
  migrationLedgerContract,
  validateOwnedMigrationSql,
  type LedgerRow,
  type ManagedMigration,
  type RemoteState,
} from "../scripts/symphony_migrations.ts"

function ledgerRow(migration: ManagedMigration): LedgerRow {
  return {
    checksum_sha256: migration.checksum,
    disposition: migration.disposition,
    migration_name: migration.name,
    version: migration.version,
  }
}

function state(
  migrations: ManagedMigration[],
  ledgerRows: LedgerRow[] = [],
): RemoteState {
  return {
    globalTotal: 274,
    globalVersions: migrations
      .filter((migration) => migration.disposition === "adopted")
      .map((migration) => migration.version),
    ledgerExists: ledgerRows.length > 0,
    ledgerRows,
  }
}

test("the private ledger adopts seven baselines and plans all owned futures", async () => {
  const { migrations } = await loadManagedMigrations()
  const plan = analyzeRemoteState(migrations, state(migrations))

  assert.equal(migrations.length, 12)
  assert.equal(plan.adoptions.length, 7)
  assert.equal(plan.applied.length, 0)
  assert.deepEqual(plan.pending.map((migration) => migration.version), [
    "20260818152105", "20260819045838", "20260819082707", "20260820070000",
    "20260820130000",
  ])
})

test("the private ledger accepts an exact ordered prefix", async () => {
  const { migrations } = await loadManagedMigrations()
  const rows = migrations.slice(0, 7).map(ledgerRow)
  const plan = analyzeRemoteState(migrations, state(migrations, rows))

  assert.equal(plan.adoptions.length, 0)
  assert.equal(plan.pending.length, 5)
})

test("the private ledger rejects drift, unknown rows, and partial adoption", async () => {
  const { migrations } = await loadManagedMigrations()
  const exactRows = migrations.slice(0, 7).map(ledgerRow)
  assert.throws(
    () => analyzeRemoteState(migrations, state(migrations, [
      ...exactRows.slice(0, 6),
      { ...exactRows[6], checksum_sha256: "0".repeat(64) },
    ])),
    /metadata drift/,
  )
  assert.throws(
    () => analyzeRemoteState(migrations, state(migrations, [
      ...exactRows,
      { ...exactRows[0], version: "20990101000000" },
    ])),
    /unknown version/,
  )
  assert.throws(
    () => analyzeRemoteState(migrations, state(migrations, exactRows.slice(0, 6))),
    /partial baseline/,
  )
})

test("the private ledger rejects global ownership of a future migration", async () => {
  const { migrations } = await loadManagedMigrations()
  const remote = state(migrations)
  remote.globalVersions.push(migrations.at(-1)!.version)
  assert.throws(() => analyzeRemoteState(migrations, remote), /global history unexpectedly owns/)
})

test("new migrations are restricted to momi_agent_ops", () => {
  assert.doesNotThrow(() => validateOwnedMigrationSql(
    "20260818152105_owned.sql",
    "-- service-owner: agent-control\ninsert into momi_agent_ops.project_mappings values ('safe');\n",
  ))
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_public.sql",
    "-- service-owner: agent-control\ncreate table public.escape (id int);\n",
  ), /public schema/)
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_global.sql",
    "-- service-owner: agent-control\ndelete from supabase_migrations.schema_migrations;\n",
  ), /global migration ledger/)
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_unqualified.sql",
    "-- service-owner: agent-control\nupdate project_mappings set active = false;\n",
  ), /outside momi_agent_ops/)
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_index.sql",
    "-- service-owner: agent-control\ncreate index escape_idx on project_mappings (active);\n",
  ), /index target is outside/)
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_privileged.sql",
    "-- service-owner: agent-control\ncreate function momi_agent_ops.f() returns void security definer language sql as 'select';\n",
  ), /security definer/)
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_transaction.sql",
    "-- service-owner: agent-control\nbegin; insert into momi_agent_ops.project_mappings values ('unsafe'); commit;\n",
  ), /transaction control/)
  assert.doesNotThrow(() => validateOwnedMigrationSql(
    "20260818152105_trigger.sql",
    "-- service-owner: agent-control\ncreate trigger safe after update on momi_agent_ops.project_mappings for each row execute function momi_agent_ops.safe();\n",
  ))
  assert.throws(() => validateOwnedMigrationSql(
    "20260818152105_dynamic.sql",
    "-- service-owner: agent-control\ncreate function momi_agent_ops.f() returns void language plpgsql as $$ begin execute command; end $$;\n",
  ), /dynamic SQL/)
})

test("each owned migration and its ledger row share the locked transaction", async () => {
  const { migrations } = await loadManagedMigrations()
  const next = migrations.at(-1)!
  const sql = buildApplySql(migrations, next)

  assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${migrationLedgerContract.advisoryLockId}\\)`))
  assert.match(sql, /create table if not exists momi_agent_ops\.schema_migrations/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /revoke all on table momi_agent_ops\.schema_migrations from public, anon, authenticated, service_role/)
  assert.doesNotMatch(sql, /(?:insert\s+into|update|delete\s+from)\s+supabase_migrations/i)
  assert.doesNotMatch(sql, /security definer/i)
  const ledgerInsert = sql.indexOf(`values ('${next.version}', '${next.name}'`)
  assert.ok(sql.indexOf(next.sql.trim()) < ledgerInsert)
  assert.ok(ledgerInsert < sql.indexOf("commit;"))
})
