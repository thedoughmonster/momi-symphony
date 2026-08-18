# Development operation

## Authority

The `development` GitHub environment and `.github/workflows/deploy-dev.yml` are
the only development migration and Edge Function deployment authority after
cutover. The target must be Supabase development ref `xtbraqnlskmqxinjxxdn`.
Production ref `viodfldzuoypnpqaagag` is forbidden.

## Required configuration

- GitHub environment secret: `SUPABASE_ACCESS_TOKEN`.
- GitHub environment variable: `SUPABASE_DEV_PROJECT_REF`.
- Migration steps remove `SUPABASE_DB_PASSWORD` and `PGPASSWORD` so the pinned
  Supabase CLI obtains its own short-lived login role.
- The private migration runner uses the linked Management API query command after
  link validation. It never reads or requires a managed database password.
- Existing Supabase function secrets remain managed in Supabase and are never printed.
- Host secrets remain in `/home/codex-dev/.config/momi-agent-control/host.env`.

## Release

1. Merge a green pull request to protected `main`.
2. Run the `preflight` phase of `Deploy development` with the exact validated
   SHA and inspect the no-write private-ledger plan. It must find all seven
   immutable baselines in the global ledger while tolerating unrelated backend
   versions and must report exactly the expected pending Symphony version.
3. Run the `runtime` phase at the same SHA and verify both Edge Functions are
   active with recorded deployed hashes.
4. Verify `curl --fail http://127.0.0.1:47931/health` returns the stable service
   identity from the repository-owned host.
5. Run the `mapping` phase at the same SHA only after host health passes. The
   runner applies one owned migration and its checksum row atomically without
   inserting, deleting, or repairing any global migration-history row.
6. Compare durable counts for mappings, envelopes, dispatches, and run records
   to the pre-cutover record.

The workflow contains no production target or automatic production trigger.
