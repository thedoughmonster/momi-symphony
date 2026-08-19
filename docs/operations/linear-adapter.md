# Linear adapter profile

Profile version: `mox-linear-v1`
Tracker kind: `linear`

This is the provider boundary for normalized issue reads. Candidate polling and
ID refresh both call the same pure normalizer and return the current OpenAI
Symphony Issue fields plus fixed, sanitized dispatchability reason codes. Core
scheduler code must not inspect GraphQL payloads, `native_ref`, Linear relation
direction, labels, or workflow-status types.

## Configuration and scope

The caller builds the profile from the already-authoritative project mapping:

- Linear project UUID;
- optional Linear team UUID;
- exact `owner/repository`;
- exact base branch.

The adapter does not add another mapping store. A missing mapping, malformed
repository/base, or project/team mismatch produces `dispatchable=false`.
Candidate and refresh reads require the project UUID before making a request.
Authentication reuses `LINEAER_ACCESS`, with `LINEAR_API_KEY` as the existing
compatibility fallback. Neither token is present in normalized output,
`native_ref`, reason evidence, or logs.

The candidate operation reads configured state names in project scope, 50 rows
per page. It returns scoped active issues even when `dispatchable=false`, omits
only records whose required normalized fields cannot be produced, and may emit
only issue identity plus a fixed error code. Missing/repeated pagination cursors
fail the whole read. The ID-refresh operation deduplicates and batches at 50,
returns full normalized snapshots, and fails the read if a returned requested
record is malformed. Empty inputs make no provider request.

## Native graph direction

Linear parent/sub-issue fields are the only hierarchy source. Any direct child
makes an issue a non-leaf, regardless of child state. Parent progress is derived
from the returned child status types and records whether the 50-row child read
was complete; there is no writable/manual progress field.

Linear represents `B --blocks--> A` on `A.inverseRelations` as a relation with
`type=blocks` and `issue=B`. That inverse connection is the only source for
`A.blocked_by`. The forward `A.relations` connection represents issues A blocks
and is intentionally not queried or normalized as a blocker. This matches the
current OpenAI Symphony Linear client and specification:
https://github.com/openai/symphony/blob/main/SPEC.md

Every native blocker preserves only its ID, identifier, and current state in
`blocked_by`. The private `native_ref` extension also retains the non-secret
state ID/type required for deterministic policy. Missing/malformed relation
state fails closed. Only Linear workflow status type `completed` is an accepted
blocker terminal. Team-specific completed names therefore work without a global
name table; `canceled` and `duplicate` explicitly do not satisfy dependencies.

## Readiness and compatibility

`dispatchable=true` requires every structural condition below:

- valid authoritative project/repository/base mapping and scope match;
- `Implementation` work-type label;
- `ready-package` attestation label;
- a second-level `Acceptance criteria` heading, optionally prefixed by the
  standard numeric section (`## 10. Acceptance criteria`), containing at least
  one Markdown list item;
- no `needs-discovery` label;
- no `blocked-external-decision` label;
- valid native parent when present;
- no direct sub-issue;
- complete, valid native relation data;
- every native blocker in Linear status type `completed`.

The readiness label is a conservative attestation, never a replacement for the
mapping, hierarchy, dependency, scope, or acceptance-section checks. The
acceptance check recognizes only the repository's explicit heading/list shape;
it does not infer readiness from prose.

Existing issues with neither a native parent nor direct sub-issues use
`allow_attested_standalone_root`. They may dispatch only after every condition
above passes, including `ready-package`. Missing hierarchy fields are malformed,
not compatibility. Parent containers remain non-dispatchable.

False results expose ordered, deduplicated enum values from
`LinearDispatchabilityReason`; no provider message or raw payload becomes a
reason. Required core-field failures map to `tracker_response`; missing project
scope maps to `invalid_tracker_config`; cursor failures map to
`tracker_pagination`. Public errors map as follows:

| Public form | Portable category |
| --- | --- |
| `linear_api_configuration_unavailable` | `missing_tracker_secret` |
| `linear_graphql_failed` | `tracker_request` (the current transport boundary intentionally coalesces HTTP/GraphQL detail) |
| `LinearAdapterError(invalid_tracker_config, …)` | `invalid_tracker_config` |
| `LinearAdapterError(tracker_response, …)` | `tracker_response` |
| `LinearAdapterError(tracker_pagination, …)` | `tracker_pagination` |

All fail the entire adapter call except an individually malformed candidate
record, which is omitted with a fixed reason and sanitized identity. The
current client does not expose reliable provider rate-limit detail, so it does
not claim a separate `tracker_rate_limited` form.

## Normalized output and ownership

Every successful record contains `id`, `native_ref`, `identifier`, `title`,
`description`, `priority`, `state`, `branch_name`, `url`, `assignee_id`,
lowercase `labels`, `blocked_by`, explicit `dispatchable`, `created_at`, and
`updated_at`. Optional unusable values become `null`; invalid priorities become
`null`; invalid timestamps become `null`. `dispatchability_reasons` is the
local observability extension. `native_ref` is JSON-safe, non-secret, and opaque
to scheduler logic.

This adapter does not schedule, claim, retry, cancel, recover, finalize discovery,
send Slack alerts, invoke a model, or change any durable run identity. Those
boundaries remain owned by their existing/downstream modules and Linear leaves.
