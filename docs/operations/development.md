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
- Host secrets remain in root-owned mode-0600 `/etc/momi-agent-control/host.env`; reviewer
  App Server state remains under group-restricted `/var/lib/momi-agent-reviewer`.

## Release

1. Merge a green pull request to protected `main`.
2. Run the `preflight` phase of `Deploy development` with the exact validated
   SHA and inspect the no-write private-ledger plan. It must find all seven
   immutable baselines in the global ledger while tolerating unrelated backend
   versions and must report exactly the expected pending Symphony version.
3. Run the `runtime` phase at the same SHA for only the required Edge Function
   selector(s), then verify each selected runtime is active with its recorded
   deployed hash.
4. Verify `curl --fail http://127.0.0.1:47931/health` returns the stable service
   identity from the repository-owned host.
5. Run the legacy-named `mapping` phase at the same SHA only after host health
   passes. The runner applies one pending owned migration and its checksum row
   atomically without inserting, deleting, or repairing any global
   migration-history row.
6. Compare durable counts for mappings, envelopes, dispatches, and run records
   to the pre-cutover record.

## Ready-leaf scheduler gate

The MOX-157 migration creates the Symphony route in `disabled` mode, and
`MOMI_AGENT_CONTROL_SCHEDULER_ENABLED` defaults to `false`. Applying the
migration or deploying the runtime therefore cannot automatically select
MOX-157 or a downstream real issue.

After a protected exact release, use the bounded procedure in
[`scheduler.md`](scheduler.md). Acceptance first uses `observe` mode with an
explicit existing issue UUID and creates no dispatch or slot. Atomic
claim/capacity behavior is proven with the disposable/transaction-rolled-back
fixture. Only a separate authorized change may record that exact release and
set the route to `enabled`. Never add a new Linear issue merely to exercise the
scheduler.

The workflow contains no production target or automatic production trigger.

## Material decision-alert gate

MOX-232 adds a separately selectable `decision-alert` runtime and a private
route that is created disabled. Deploying the migration or either runtime
cannot send Slack by itself. Follow [`decision-alerts.md`](decision-alerts.md)
for exact-release no-send preflight, destination fresh-read, one-issue
acceptance, resolution, and immediate disablement. Never reuse or modify an
order-alert route to activate decision alerts.
