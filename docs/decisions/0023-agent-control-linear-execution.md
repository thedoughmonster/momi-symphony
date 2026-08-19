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
  #523 / MOX-159; MOX-157

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

MOX-157 extends the same boundary with one fixed host-owned scheduler pump.
The host sends only its scheduler identity, exact release identity, and bounded
active work IDs to the existing authenticated agent-control endpoint.
Agent-control fetches provider data through the normalized issue adapter,
persists candidate generations, and atomically reserves route/action-class
capacity before creating a normal `execute-run` dispatch. The host never sees
or interprets Linear payloads.

Candidate ordering is priority `1..4` ascending, other/null priority last,
creation time oldest/null last, then identifier. Issue-level priority aging is
not part of this comparator. A blocked or otherwise unroutable leaf may have a
waiting projection, but it creates no dispatch and consumes no slot. A false to
true eligibility transition creates a new fenced generation; stale generations
cannot be resumed. Provider failure becomes bounded technical retry state and
never a human decision alert.

Automatic claims are doubly fail closed: the database route policy is created
in `disabled` mode and the host pump defaults off. `observe` mode requires an
explicit issue allowlist and cannot claim. `enabled` mode requires a recorded
exact protected-release SHA and completed development acceptance receipt.

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

Discovery finalization is not another catalog action or host lifecycle. A
current explicit user request inside the retained task activates the
repository-scoped `linear-finalize-discovery` skill. It may search, read, and
write only native Linear planning; it reuses identities, preserves unrelated
human content, verifies the native parent/blocker graph, applies the normalized
readiness contract, and reads back every affected issue. It neither archives
the retained task nor creates repository or delivery artifacts, execution
labels, tasks, dispatches, merges, releases, or deployments. Silence, turn
completion, retention, and archive never activate it.

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

## Material decision alerts (MOX-232 amendment)

Linear remains authoritative for human decisions. An eligible decision is one
whole top-level comment with the exact `momi-decision:v1` marker and one bounded
JSON object, paired with the existing `blocked-external-decision` label. The
object carries a stable decision key, one of the eight accepted material
categories, `unresolved` or `resolved` status, the concise question and policy
gap, recommendation, alternatives, consequences, affected issue identifiers,
and a resolution summary only when resolved. The durable identity is
`linear:<issue UUID>:<comment UUID>:<decision key>`. Unknown categories,
multiple records, malformed content, record/label disagreement, sensitive
patterns, and technical exclusions fail closed without delivery.

The explicit material categories are architecture/service ownership, public
contract, security/privacy, meaningful cost/external exposure, destructive
migration, production infrastructure/authority, genuinely ambiguous product
behavior, and irreconcilable requirements/repository law. Native dependencies,
tests/validation, retryable infrastructure, stale branches, missing generated
files, agent-correctable defects, and an already-active identity are never
decision alerts.

`agent-control` owns private policy, normalized decision state, delivery work,
attempts, and receipts in `momi_agent_ops`. Reconciliation stores only bounded
sanitized fields, then rotates a one-time capability. The separate
`decision-alert-delivery` destination adapter claims that capability and is the
only new Slack HTTP boundary. It does not read, write, join, or extend the
`momi_alerting` order-alert destination, route, prepared-message, work, attempt,
or receipt relations. The project-scoped `SLACK_BOT_TOKEN` is authorized for
this function only through its explicit service/function manifests and the
private decision destination allowlist.

An attempt row is committed by the claim before Slack I/O. A provider `429` is
known-no-delivery and may become retryable using bounded `Retry-After`; network,
server, malformed-body, or receipt uncertainty becomes `ambiguous` and can
never be retried blindly. Initial success records only channel/message receipt
identity. A resolved update is one reply to that receipt after the same Linear
comment becomes `resolved` and the blocking label is removed. The normalized
adapter then restores later scheduler eligibility when every other condition
passes.

The route is created `disabled`. Development acceptance additionally requires
an allowlisted issue UUID, exact protected-release SHA, acceptance timestamp,
an independently fresh-read Slack channel, and a successful no-send probe that
reports only secret/database presence. Production activation is not authorized.

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
- Decision-alert messages disable markdown parsing, mentions, and unfurls. No
  raw prompt, provider response body, bearer credential, or protected context
  enters the decision-alert lifecycle or logs.

## Failure and rollback

Each boundary is idempotent. Claims use short leases; retries rotate the
capability token, and ambiguous host creation remains quarantined rather than
repeated. Linear labels/comments are reconciled from durable state. A failed
ingress transaction cannot enqueue network work.

Rollback removes the functions and trigger only through the normal manifest
retirement and additive-migration process. Existing ledger history and retained
interactive task identities are preserved;
no rollback repeats an ambiguous task creation.

Decision-alert rollback calls the dedicated disable routine first. It clears
only the acceptance allowlist and returns the route to `disabled`; Linear
decisions, bounded attempts, Slack receipts, and ambiguous evidence remain.
