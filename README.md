# Agent control

## ELI5

This service turns one declared Linear action label into durable Codex work.
It keeps a private receipt at every step so retries cannot accidentally create
a second task. One-shot actions archive after their terminal turn; discovery
hands one named task to the user for an ongoing conversation.

Linear sends a signed webhook to the ingress function. The service records the
complete source envelope and creates work only when `updatedFrom` proves that
exactly one declared action was newly added. A post-commit database adapter
wakes the dispatch function with only a work ID and one-use capability token.

The dispatch function claims durable work, calls the authenticated Codex host
adapter, and reconciles the consumed action, `has-run`, and one marker-bound
Linear comment. The durable dispatch proves that the action was added, so consuming
the label after task creation does not invalidate the task's readiness check.
The host adapter talks to the installed Codex App Server, persists its
idempotency reservation outside the repository, and archives terminal threads.

The first project mapping is Backend Stabilization to
`thedoughmonster/momi-backend` on `dev`. Unknown projects are explained in
Linear and never reach Codex. `execute-run` owns direct implementation;
`validate-issue`, `investigate-issue`, `cleanup`, and `decompose` receive
distinct one-shot non-execution instructions. `run-discovery` starts a named,
unstructured, multi-turn task and asks one question at a time. `cancel-run`
withdraws queued work, requests interruption of an exact active host turn, or
records an already-terminal, absent-target, or operator-intervention result.

An `execute-run` on an issue with direct children creates one visible parent
task. That task preflights children and uses their one-shot `execute-run` labels;
the ingress links each child dispatch to the active parent. The unique parent/
child edge prevents duplicate child work, while dispatch and run records retain
an aggregate ledger after every Codex task is archived. Neither service invokes
Symphony.

Runtime secrets are `SUPABASE_DB_URL`, `LINEAR_WEBHOOK_SECRET`,
`LINEAER_ACCESS` (with `LINEAR_API_KEY` accepted as a compatibility fallback),
and `MOMI_CODEX_HOST_SECRET`. The HTTPS host endpoint is private project
configuration in `momi_agent_ops.project_mappings`; host-specific paths are
not committed. Hosted activation remains a post-review
release step; no local command applies these migrations or deploys functions.
