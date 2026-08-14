# Agent control

## ELI5

This service turns one deliberate Linear label into one visible Codex task. It
keeps a private receipt at every step so retries cannot accidentally create a
second task, then archives the task when its turn is terminal.

Linear sends a signed webhook to the ingress function. The service records the
complete source envelope and creates work only when `updatedFrom` proves that
`execute-run` was newly added. A post-commit database adapter wakes the dispatch
function with only a work ID and one-use capability token.

The dispatch function claims durable work, calls the authenticated Codex host
adapter, and reconciles `execute-run`, `has-run`, and one marker-bound Linear
comment. The host adapter talks to the installed Codex App Server, persists its
idempotency reservation outside the repository, and archives terminal threads.

The first project mapping is Backend Stabilization to
`thedoughmonster/momi-backend` on `dev`. Unknown projects are explained in
Linear and never reach Codex. This service does not dispatch Symphony and does
not implement the broader action catalog or parent/cancellation coordination.

Runtime secrets are `SUPABASE_DB_URL`, `LINEAR_WEBHOOK_SECRET`,
`LINEAER_ACCESS` (with `LINEAR_API_KEY` accepted as a compatibility fallback),
and `MOMI_CODEX_HOST_SECRET`. The HTTPS host endpoint is private project
configuration in `momi_agent_ops.project_mappings`; host-specific paths are
not committed. Hosted activation remains a post-review
release step; no local command applies these migrations or deploys functions.
