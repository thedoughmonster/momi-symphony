# Linear action webhook v1

## ELI5

Linear signs a sealed envelope. This function checks the seal before opening
the envelope, stores the complete letter, and creates work only when the label
change explicitly adds one retained action, or when an issue enters native `Canceled`.

## Trigger And Input

Linear sends an HTTPS `POST` issue webhook. `GET` is a configuration-only probe.

The untouched UTF-8 body, `Linear-Signature`, and `Linear-Delivery` headers.
Only `update` events for `Issue` can request work. Label actions require a changed
`labels` field in `updatedFrom`; cancellation requires a changed `state`/`stateId`
whose new native state is `Canceled`. Retained direct labels are `investigate-issue`,
`run-discovery`, and `recover-discovery`; `execute-run` is accepted only for a child
of an active durable parent coordination run. `request escalated validation` is
read by the ready-leaf scheduler and creates no direct action. Routine `cancel-run`,
`validate-issue`, `cleanup`, and `decompose` labels are inert.

## Output

JSON with `ok` and a durable disposition. Auth failures return `401`, malformed
verified events return `400`, and database failures return `503` for retry.

## Side Effects

One transaction stores the raw envelope and, when eligible, creates one
dispatch and run. Child execute work links to an active parent; queued native
cancellation withdraws its exact lifecycle tree in the same transaction. The function
performs no LLM, Codex, Linear API, or downstream HTTP call. Duplicate
deliveries converge on the existing receipt and work.

## Failure Handling

Authentication and stale timestamps fail closed after audit recording. A
database error returns a retryable server response, and no downstream work can
exist unless the receipt-and-dispatch transaction commits.

## Tests

Tests cover raw-byte signature verification, timestamp/auth failure, label
normalization, ignored updates, idempotent persistence calls, and failed commits.
