# Agent dispatch v1

## ELI5

This worker picks up one sealed work ticket, starts or cancels exact Codex work,
updates Linear, and later records terminal archive evidence. Repeated knocks
reuse the same ticket and task.

## Trigger And Input

An ADR-0004 database trigger sends `work_id` and `capability_token` after commit.
The authenticated host adapter uses the same route for a terminal callback.
`GET` is a configuration-only probe.

Dispatch input contains only the work identity and per-work token. Terminal
input additionally carries the accepted thread/turn identities, readiness,
terminal disposition, and archive timestamp; it also requires the host bearer
secret.

## Output

JSON reports active, cancellation, terminal, duplicate, rejection, or retry
dispositions without exposing the capability token or prompt.

## Side Effects

The function atomically claims private work, builds the bounded instruction for
its stored action, resolves that project's private HTTPS Codex-host endpoint,
and performs marker-bound Linear label/comment reconciliation. Parent/child
links and queued cancellation are already sealed in the claimed work. Active
cancellation calls the host's exact turn-interruption contract. Failures
release work with bounded backoff. Host idempotency prevents duplicate tasks.

## Tests

Tests cover claim/retry phases, parent linkage, all cancellation states, host
idempotency, accepted labels/comments, callback replay, and archive bookkeeping.

## Failure Handling

Invalid capabilities and callbacks fail closed. A delivery failure releases
the short claim with bounded backoff; an ambiguous host start stays reserved
and cannot be repeated automatically.
