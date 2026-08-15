# Linear action webhook v1

## ELI5

Linear signs a sealed envelope. This function checks the seal before opening
the envelope, stores the complete letter, and creates work only when the label
change explicitly adds exactly one declared action.

## Trigger And Input

Linear sends an HTTPS `POST` issue webhook. `GET` is a configuration-only probe.

The untouched UTF-8 body, `Linear-Signature`, and `Linear-Delivery` headers.
Only `update` events for `Issue` can request work, and only a changed `labels`
field in `updatedFrom` is semantic evidence. The declared catalog is
`execute-run`, `cancel-run`, `validate-issue`, `investigate-issue`, `cleanup`, `decompose`,
and `run-discovery`; multi-action additions are ignored as ambiguous.

## Output

JSON with `ok` and a durable disposition. Auth failures return `401`, malformed
verified events return `400`, and database failures return `503` for retry.

## Side Effects

One transaction stores the raw envelope and, when eligible, creates one
dispatch and run. Child execute work links to an active parent; queued
cancellation withdraws its exact target in the same transaction. The function
performs no LLM, Codex, Linear API, or downstream HTTP call. Duplicate
deliveries converge on the existing receipt and work.

## Failure Handling

Authentication and stale timestamps fail closed after audit recording. A
database error returns a retryable server response, and no downstream work can
exist unless the receipt-and-dispatch transaction commits.

## Tests

Tests cover raw-byte signature verification, timestamp/auth failure, label
normalization, ignored updates, idempotent persistence calls, and failed commits.
