# Agent dispatch v1

## ELI5

This worker picks up one sealed work ticket, asks the local Codex host for one
visible task, updates Linear, and later records the host's terminal archive
receipt. Repeated knocks reuse the same ticket and task.

## Trigger And Input

An ADR-0004 database trigger sends `work_id` and `capability_token` after commit.
The authenticated host adapter uses the same route for a terminal callback.
`GET` is a configuration-only probe.

Dispatch input contains only the work identity and per-work token. Terminal
input additionally carries the accepted thread/turn identities, readiness,
terminal disposition, and archive timestamp; it also requires the host bearer
secret.

## Output

JSON reports `accepted`, `active`, `completed`, `duplicate`, `rejected`, or
`retrying` without exposing the capability token or prompt.

## Side Effects

The function atomically claims private work, calls only the configured Codex
host, and performs marker-bound Linear label/comment reconciliation. Failures
release work with bounded backoff. Host idempotency prevents duplicate tasks.

## Tests

Tests cover claim/retry phases, unknown/unready write-back, host idempotency,
accepted labels/comments, callback replay, and terminal archive bookkeeping.

## Failure Handling

Invalid capabilities and callbacks fail closed. A delivery failure releases
the short claim with bounded backoff; an ambiguous host start stays reserved
and cannot be repeated automatically.
