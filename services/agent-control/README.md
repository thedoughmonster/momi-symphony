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

The dedicated project mapping is Symphony Control Plane to
`thedoughmonster/momi-symphony` on `main`. Unknown projects are explained in
Linear and never reach Codex. `execute-run` owns direct implementation;
`validate-issue`, `investigate-issue`, `cleanup`, and `decompose` receive
distinct one-shot non-execution instructions. `run-discovery` starts a named,
unstructured, multi-turn task and asks one question at a time. `recover-discovery`
retries exact interruption and archive of that retained task without starting
another Codex task. It releases ownership only after archive confirmation and
keeps ownership on retryable failure. `cancel-run`
withdraws queued work, requests interruption of an exact active host turn, or
records an already-terminal, absent-target, or operator-intervention result.

Inside a retained discovery, only a current explicit user request to finalize
into Linear activates the repository-scoped `linear-finalize-discovery` skill.
That skill searches and re-reads before writing the minimum native Linear graph,
applies the `mox-linear-v1` readiness contract, verifies every write, and keeps
the discovery task open. It has no repository, execution-action, dispatch,
merge, release, or deployment authority; quiet turns, retention, and archive
never imply finalization.

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

The provider-specific normalized issue/readiness contract is documented in
[`docs/operations/linear-adapter.md`](../../docs/operations/linear-adapter.md).
Candidate and ID-refresh readers return normalized fields only; downstream
scheduler code must not reconstruct Linear hierarchy or blocker policy.

The single MOX-157 scheduler is a host-owned 10–60 second pump through the
existing authenticated dispatch function. Agent-control applies normalized
`dispatchable`, active-state, required-label, claim, and capacity checks,
refreshes a candidate immediately before the atomic database claim, and uses
one route-scoped leader plus fenced candidate/slot generations. The migration
and host pump are both disabled by default; see
[`docs/operations/scheduler.md`](../../docs/operations/scheduler.md).

## Exact dead-letter recovery

`momi_agent_ops.recover_dead_letter_dispatch_v1` is a private database-owner
operator control for one audited delivery failure. It reactivates the existing
dispatch; it does not create a webhook, dispatch, run, or Linear action record.
The operator must supply the exact dispatch ID, issue identifier, prior attempt
count and error code, current stable HTTPS dispatch route, and the authorizing
Linear issue identifier.

The routine locks the dispatch and requires the audited dead-letter shape: eight
failed host deliveries, no host acceptance or host identity, a pending and
non-terminal run, no prior recovery, and an active mapping that still matches
the dispatch repository, base branch, and supplied route. It records the prior
failure evidence, generates a fresh capability internally, and makes the same
dispatch immediately pending so the existing wake trigger performs delivery.
The capability is never returned or logged.

The first exact invocation returns `recovered`; an identical replay returns
`already_recovered`. Any changed input, mapping, host identity, run state, or
prior conflicting recovery fails closed. Execution is revoked from `PUBLIC`,
`anon`, `authenticated`, and `service_role`, so hosted runtime code cannot use
this operator control. Apply the migration only through the receipt-bound
development release, recapture the baseline before invocation, invoke once as
the development database owner, and then observe the existing dispatch rather
than issuing another wake or dispatch.
