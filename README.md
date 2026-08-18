# MoMi Symphony control plane

This repository is the durable owner of the MoMi `agent-control` and
`agent-control-host` services. It receives signed Linear actions, records one
idempotent dispatch, and hands an authenticated canonical request to the local
Codex App Server host adapter.

The implementation and its meaningful path history were extracted from
`thedoughmonster/momi-backend`. That repository retains its seven already
applied migration files as immutable history, but it no longer owns executable
code, deployment, or future schema changes for these services.

## Local checks

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Run the host only with an operator-owned environment file containing the names
documented in `.env.example`:

```sh
pnpm agent-control:host
curl --fail http://127.0.0.1:47931/health
```

See `docs/operations/development.md` for development release and verification,
`docs/operations/migration-authority.md` for the database handoff, and
`docs/operations/rollback.md` before any cutover.

Production activation is intentionally outside this repository-transfer issue.
