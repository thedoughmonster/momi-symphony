# Agent dispatch v1

## ELI5

This worker picks up one sealed work ticket, starts, cancels, or recovers exact Codex work,
and updates Linear. One-shot work later records terminal archive evidence;
interactive discovery remains active until explicit archive. Repeated knocks
reuse the same ticket and task.

## Trigger And Input

An ADR-0004 database trigger sends `work_id` and `capability_token` after commit.
The authenticated host adapter uses the same route for a terminal callback.
The same bearer-authenticated route accepts the host-owned scheduler pump; its
input contains only a scheduler UUID, exact release SHA, and bounded active
work IDs.
The same authenticated boundary accepts a bounded `projection_replay` request
containing one to fifty explicit completed dispatch IDs.
`GET` is a configuration-only probe.

Dispatch input contains only the work identity and per-work token. Terminal
input additionally carries the accepted thread/turn identities, readiness,
terminal disposition, and archive timestamp; it also requires the host bearer
secret.

## Output

JSON reports active, cancellation, terminal, duplicate, rejection, or retry
dispositions without exposing the capability token or prompt.

## Side Effects

The function atomically claims private work, builds the bounded instruction and
interaction mode for its stored action, resolves that project's private HTTPS
Codex-host endpoint,
and performs marker-bound Linear label/comment reconciliation. Parent/child
links and queued cancellation are already sealed in the claimed work. Active
cancellation calls the host's exact turn-interruption contract. Failures
release work with bounded backoff. Host idempotency prevents duplicate tasks.
Discovery recovery calls the exact retained-task recovery contract, writes a
sanitized pending status before host delivery, and never starts a Codex task.
The scheduler pump reads normalized candidates, reconciles their current
generation, refreshes an issue immediately before an atomic claim, and creates
the existing dispatch shape only after both route and action-class capacity are
reserved. `observe` mode cannot claim.
The heartbeat creates a durable issue quarantine when host evidence disappears; the issue fence
survives while route capacity is released after the configured intervention window. Quarantine
invalidates unaccepted wake capability and absorbs late active/acceptance signals. Count-only
receipts expose quarantine creation, age, capacity release, and manual-intervention pressure.
Terminal execution is committed before
Linear reconciliation; a failed projection is leased, visible, and retried by
the scheduler or explicit replay without another host task or model turn. Each
projection result is fenced by the attempt generation returned with its
ten-minute lease. A database terminal trigger also keeps the prior v5 callback
runtime safe during rollback.

## Tests

Tests cover claim/retry phases, parent linkage, cancellation and recovery states, host
idempotency, accepted labels/comments, callback replay, and archive bookkeeping.

## Failure Handling

Invalid capabilities and callbacks fail closed. A delivery failure releases
the short claim with bounded backoff; an ambiguous host start stays reserved
and cannot be repeated automatically.
