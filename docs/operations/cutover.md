# Development cutover record

## Preconditions

- Private `thedoughmonster/momi-symphony` exists and `main` is protected.
- CI is green at the exact cutover commit.
- The repository has the development environment and least-privilege secrets.
- The current durable count snapshot is recorded.
- The host ledger is backed up without exposing its contents.

## Ordered cutover

1. Deploy the exact validated `main` commit through `Deploy development`.
2. Install `ops/systemd/momi-agent-control-host.service` in the user unit directory.
3. Set host repository/base values to `thedoughmonster/momi-symphony` and `main`.
4. Reload and restart the host service; verify `/health` locally and through the private route.
5. Apply the mapping migration only after the new repository and host are ready.
6. Reconcile the four durable table counts and active host callback identity.
7. Merge the backend retirement pull request.

Do not dispatch a canary that writes Linear until all read-only checks pass.
