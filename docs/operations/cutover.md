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
4. Provision distinct `momi-agent-control` host and `momi-agent-reviewer`
   reviewer identities plus a `momi-agent-review` group containing only those
   identities. Provision a root-owned
   mode-0400 `/etc/momi-agent-control/review-ledger-key` containing exactly 32
   random bytes, and a root-owned mode-0600 `/etc/momi-agent-control/host.env`.
   Keep `/var/lib/momi-agent-control` mode 0700 and owned only by the host.
   Keep `/var/lib/momi-agent-reviewer` mode 0750 and owned by the reviewer and
   narrow review group; provision reviewer auth/config only beneath its
   `codex-home`, and create a private canonical clone at `repository`. Install the exact
   protected release root-owned at `/opt/momi-symphony/current` and install the
   reviewed Codex binary root-owned at `/usr/local/bin/codex`. Grant
   only the repository and implementation App Server socket access required by
   the adapter. Install both repository-owned systemd units, set `CODEX_HOME` to
   the implementation daemon home, `MOMI_REVIEW_CODEX_HOME` to
   `/var/lib/momi-agent-reviewer/codex-home`,
   `MOMI_REVIEW_REPOSITORY_ROOT` to
   `/var/lib/momi-agent-reviewer/repository`,
   `MOMI_REVIEW_WORKSPACE_ROOT` to `/var/lib/momi-agent-reviewer/workspaces`, and set
   the host repository/base values to `thedoughmonster/momi-symphony` and `main`.
5. Reload systemd, restart the reviewer App Server and host services, verify the
   two sockets have different owning identities/state roots, then verify
   `/health` locally and through the private route.
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
