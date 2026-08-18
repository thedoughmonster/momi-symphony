# Development cutover record

## Preconditions

- Public `thedoughmonster/momi-symphony` passed the sensitive-history audit and
  `main` is protected.
- CI is green at the exact cutover commit.
- The repository has the development environment and least-privilege secrets.
- The current durable count snapshot is recorded.
- The host ledger is backed up without exposing its contents.

## Ordered cutover

1. Run the `preflight` phase of `Deploy development` at the exact validated
   `main` commit. It must report only the expected pending mapping migration and
   must not apply it.
2. Run the `runtime` phase at the same commit to deploy both Edge Functions
   without applying migrations.
3. Back up the current ledger, user unit, and environment file without exposing
   their contents.
4. Install `ops/systemd/momi-agent-control-host.service` in the user unit directory
   and set the host repository/base values to `thedoughmonster/momi-symphony` and
   `main`.
5. Reload and restart the host service; verify `/health` locally and through the
   private route.
6. Run the `mapping` phase at the same commit. It repeats the dry run before
   applying the mapping migration, after the new repository and host are ready.
7. Reconcile the four durable table counts and active host callback identity.
8. Exercise the bounded rollback with
   `ops/sql/disable_symphony_control_plane_mapping.sql`, restore the previous
   host, and prove durable counts and identities did not change.
9. Restore the repository-owned host and run
   `ops/sql/enable_symphony_control_plane_mapping.sql`; both scripts fail unless
   the exact HTTPS mapping is updated once.
10. Reconcile the final active mapping and host health before merging the backend
    retirement pull request.

Do not dispatch a canary that writes Linear until all read-only checks pass.
