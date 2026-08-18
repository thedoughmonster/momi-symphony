# Development operation

## Authority

The `development` GitHub environment and `.github/workflows/deploy-dev.yml` are
the only development migration and Edge Function deployment authority after
cutover. The target must be Supabase development ref `xtbraqnlskmqxinjxxdn`.
Production ref `viodfldzuoypnpqaagag` is forbidden.

## Required configuration

- GitHub environment secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.
- GitHub environment variable: `SUPABASE_DEV_PROJECT_REF`.
- Existing Supabase function secrets remain managed in Supabase and are never printed.
- Host secrets remain in `/home/codex-dev/.config/momi-agent-control/host.env`.

## Release

1. Merge a green pull request to protected `main`.
2. Run `Deploy development` with the exact validated SHA.
3. Verify both Edge Functions are active and their deployed hashes are recorded.
4. Verify `curl --fail http://127.0.0.1:47931/health` returns the stable service identity.
5. Compare durable counts for mappings, envelopes, dispatches, and run records to the pre-cutover record.

The workflow contains no production target or automatic production trigger.
