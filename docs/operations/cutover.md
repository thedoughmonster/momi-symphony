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
   `main` commit. It must adopt no remote state, tolerate the backend's unrelated
   global history, and report only the expected pending mapping migration.
2. Run the `runtime` phase at the same commit to deploy both Edge Functions
   without applying migrations.
3. Back up the current ledger, host unit, and environment file without exposing
   their contents.
4. Provision the dedicated `momi-agent-control` service identity, a root-owned
   mode-0400 `/etc/momi-agent-control/review-ledger-key` containing exactly 32
   random bytes, the systemd-managed state directory, and only the repository
   and private App Server socket access required by the adapter. Install
   `ops/systemd/momi-agent-control-host.service` as a system unit and set the
   host repository/base values to `thedoughmonster/momi-symphony` and `main`.
5. Reload and restart the host service; verify `/health` locally and through the
   private route.
6. Run the `mapping` phase at the same commit. It repeats the no-write private
   ledger plan before applying the mapping migration and its ledger row in one
   locked transaction, after the new repository and host are ready.
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
