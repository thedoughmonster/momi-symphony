# Migration authority handoff

The development database contains seven applied `agent-control` migrations.
Their exact byte hashes are pinned in `config/migration-baseline.json` and tested
in CI. The same files remain unchanged in `momi-backend` so its historical
migration ledger is never rewritten.

The Supabase CLI has no configurable per-repository migration-history table in
version 2.109.1: `db push` always compares the complete local directory with
`supabase_migrations.schema_migrations`. Development already has hundreds of
unrelated backend versions, so this repository uses a deliberately private
ledger instead of altering or falsifying that global history.

`scripts/symphony_migrations.ts` owns `momi_agent_ops.schema_migrations`. It:

- verifies the pinned development link and rejects managed password variables;
- proves the seven byte-pinned baselines exist in the global history, then adopts
  their names and SHA-256 checksums without executing their SQL;
- validates every later file as narrowly owned `momi_agent_ops` SQL;
- rejects checksum drift, unknown or duplicated versions, partial adoption,
  out-of-order state, and any future Symphony version in the global ledger;
- serializes writers with advisory transaction lock `5570477968790471985`; and
- executes at most one pending migration and inserts its private-ledger row in
  the same transaction.

The ledger bootstrap is deterministic runner infrastructure rather than a new
Supabase migration file. Making it a CLI migration would put the bootstrap back
in the shared global ledger it exists to avoid. The runner creates only the
private table, enables RLS, and revokes access from `public`, `anon`,
`authenticated`, and `service_role`; it creates no `SECURITY DEFINER` routine.

The workflow still links the exact development ref first. That link validates
the CLI's short-lived login path. Custom-ledger reads and writes then use the
CLI's documented linked `db query` path, which CLI 2.109.1 implements through
the Supabase Management API with `SUPABASE_ACCESS_TOKEN`; no database password
or credential-bearing URI is used or logged.

After the repository cutover:

- this repository is the sole authority for every new `momi_agent_ops` migration;
- `momi-backend` rejects new migrations owned by `agent-control`;
- only this repository's manual development workflow may apply those changes;
- the backend's `supabase_migrations.schema_migrations` ledger remains untouched;
- production contains no `momi_agent_ops` schema or matching migration versions;
- production activation requires a separate approved issue.

The cutover is compatible rather than a data copy: development continues using
the existing private schema, functions, four durable tables, and recovery job.
No row identity changes. Pre-cutover reconciliation recorded 2 project mappings,
842 webhook envelopes, 39 dispatches, 39 run records, 0 nonterminal dispatches,
and 1 active recovery job. The shared global ledger had 274 rows: all seven
immutable agent baselines, no pending mapping version, and 267 unrelated rows.
The private ledger and Symphony mapping were absent. Production had no agent
schema, private ledger, agent migration version, or agent Edge Function.
