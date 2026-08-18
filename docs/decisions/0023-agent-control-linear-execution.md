# 0023: Linear-driven Codex agent control

> Repository handoff (2026-08-18): the original architecture remains valid,
> but executable ownership, development deployment, and future
> `momi_agent_ops` migration authority moved to
> `thedoughmonster/momi-symphony` on `main`. The original mapping below is
> retained as historical decision context; the active mapping is Symphony
> Control Plane to the dedicated repository.

- Status: accepted
- Date: 2026-08-14
- Owning issues: #504 / MOX-151; #517 / MOX-152; #519 / MOX-153;
  #523 / MOX-159

## Context

Linear needs one-shot action labels that create visible Codex tasks
without making a webhook, database trigger, or Edge Function a long-running
executor. Provider retries must not duplicate the task, and the private control
ledger must not become a client-facing data contract.

## Decision

Create `agent-control` as the owner of the private `momi_agent_ops` operational
dataset, and `agent-control-host` as the independently deployable destination
adapter for the external Codex-host boundary. A Linear-specific ingress Edge
Function verifies HMAC-SHA256 against
the untouched request bytes, records the complete envelope, and normalizes only
fields named by `updatedFrom`. Exactly one newly added declared action creates
canonical dispatch and run records in the same transaction.

The accepted catalog is `execute-run`, `cancel-run`, `validate-issue`, `investigate-issue`,
`cleanup`, `decompose`, `run-discovery`, and `recover-discovery`. Events that add more than one
catalog action are ambiguous and do not create work. Each accepted action is
stored on the dispatch, consumed after host acceptance, and reported in the
marker-bound Linear comment. Provider retries converge on the delivery receipt.

Project routing is configuration owned by `momi_agent_ops.project_mappings`.
The first mapping is the Linear Backend Stabilization project to
`thedoughmonster/momi-backend` at `dev`; unknown projects fail closed.

After commit, a dedicated ADR-0004 trigger adapter sends only the dispatch ID
and a per-work capability token to the exact dispatch Edge Function. The
function atomically claims work, then calls the versioned
`momi.agent_control.host_dispatch.v1` contract on the mapped, authenticated
private HTTPS Codex host adapter. This is the exact internal HTTP exception
accepted by this ADR; it authorizes no general service-to-service calls. The adapter durably
reserves the dispatch before issuing Codex
App Server `thread/start` and `turn/start`, so an ambiguous retry cannot create
a second task. It archives the thread after terminal `turn/completed` and sends
an authenticated terminal callback for durable and Linear write-back.

The initial Codex turn contains only the accepted action, stable issue and
mapping identities, plus a bounded action-specific instruction. `execute-run`
owns repository implementation; the other actions are limited to validation,
investigation, metadata cleanup, decomposition, or discovery. Symphony is not
in this boundary.

`run-discovery` is the catalog's interactive exception. Host dispatch v2 names
its non-ephemeral thread before the first turn and omits structured terminal
output. A normally completed discovery turn moves the durable host record to a
retained interactive state; it does not archive the thread or send a terminal
callback. The same visible task accepts later user turns. Explicit task archive
or exact cancellation closes the retained session and resumes the existing
terminal callback. All other catalog actions retain one-shot archival behavior,
and host dispatch v1 remains accepted during development cutover. Race recovery
reads a newly started thread without resuming it; only startup recovery resumes
stored threads to restore event subscriptions after a host restart. The host uses
the managed App Server daemon's private Unix WebSocket and unsubscribes after
retaining an interactive turn, releasing the same visible task for later input.

`recover-discovery` is the bounded control path for a retained discovery whose
archive needs to be retried. It resolves the exact retained dispatch regardless
of Linear workflow state, reads the retained thread, interrupts and confirms
the sole active turn when present, then archives the thread and releases durable
ownership. Missing, ambiguous, or mapping-mismatched targets produce sanitized
unready evidence. Archive failure retains ownership and retries the same
recovery identity; it cannot start a task. Force release and generalized
recovery controls are not part of this contract.

For parent runs, the visible parent task reads and preflights the direct Linear
child graph. It applies each eligible child's one-shot `execute-run` label; the
ingress links that child dispatch to the active parent dispatch and enforces one
child dispatch per parent/issue pair. Parent state is reconstructed from those
durable dispatch edges and child run records after task archival. The parent
task reports deterministic eligibility, aggregate progress, partial failure,
retry, and intervention evidence in Linear. It does not invoke Symphony.

`cancel-run` creates a separate durable command targeting the newest
`execute-run` for the same issue. Pending work is withdrawn transactionally;
an exact active host turn receives idempotent `turn/interrupt`; terminal replay
is successful; missing and ambiguous targets produce explicit Linear evidence.

## Security and authority

- `momi_agent_ops` is absent from the Supabase Data API schema list; RLS and
  explicit revokes provide defense in depth.
- Edge Functions access the private schema only through `SUPABASE_DB_URL` and
  explicitly granted routines.
- Linear and Codex-host secrets remain runtime secrets and never enter payload
  logs, prompts, database records, or trigger bodies.
- The non-secret host URL is HTTPS-only private project configuration, resolved
  at claim time so endpoint rotation does not require an Edge Function secret
  change. The bearer credential remains a runtime secret. The service declares
  `api.linear.app` and that configured boundary as outbound authority.
- Trigger networking is restricted to the exact dispatch route and the standard
  project URL/publishable-key Vault records accepted by ADR 0004.

## Failure and rollback

Each boundary is idempotent. Claims use short leases; retries rotate the
capability token, and ambiguous host creation remains quarantined rather than
repeated. Linear labels/comments are reconciled from durable state. A failed
ingress transaction cannot enqueue network work.

Rollback removes the functions and trigger only through the normal manifest
retirement and additive-migration process. Existing ledger history and retained
interactive task identities are preserved;
no rollback repeats an ambiguous task creation.
