# Execution context and telemetry

MOX-234 defines `mox-execution-efficiency-v1` as the first bounded execution
policy. Agent-control builds one versioned action-context envelope per durable
dispatch. Each included source has a stable identity, fingerprint, required
flag, and inclusion reason. The envelope requests the current Linear issue,
native relations, exact project mapping, repository rules, and only the owning
service rules needed by the action; broad comment history and unrelated
documentation are excluded by default.

The host v3 contract sends the action rules as one stable input item and the
issue, mapping, and attempt delta as a later volatile item. Their fingerprints
are persisted without storing unrestricted prompt content. Legacy v1/v2 host
requests remain readable for durable recovery, but new dispatches use v3.

Per-action policy caps model turns, no-progress cycles, subagent count/depth,
model-visible tool bytes, and elapsed time. The host refuses budgets above the
documented hard maxima, interrupts the exact turn on elapsed-time exhaustion,
and converts every measured overrun into a typed failed terminal result. Ticket
prose cannot alter these limits. Readiness, scheduling, dependency/status
reconciliation, CI polling, cancellation, cleanup/recovery routing, Slack
deduplication, and retry classification remain deterministic control-plane
operations and do not start Codex turns.

Tool evidence uses compact success or failure receipts. Receipts retain a stable
command identity, duration, output hash, and artifact reference. Failures add a
bounded redacted diagnostic, path/line evidence, error code, and repair class.
Full output stays behind the referenced artifact and bearer, token, key, secret,
and password values are removed before model-visible use.

Checkpoints contain only issue/tree/policy revisions, milestone, receipt
identities, and failure fingerprints. A continuation fails closed when those
revisions change and receives only the checkpoint plus new evidence. Two prior
identical failure fingerprints stop a third repair attempt.

`momi_agent_ops.execution_attempt_telemetry` stores input, cached-input, and
output tokens when the runtime reports them, plus tool bytes, model turns,
no-progress cycles, subagent count/depth, retries, repeated diagnostics, elapsed
time, and terminal disposition. `execution_action_percentiles_v1` reports p50
and p95 by action and policy version. Establish a pre-change policy baseline
before describing savings; no universal saving percentage is implied.

## Rollback

Revert new dispatch creation to host schema v2 while retaining v3 parsing,
telemetry rows, and checkpoints for audit. This restores the prior prompt
transport without weakening mapping, readiness, validation, cancellation, or
terminal receipt rules. Do not drop telemetry during rollback. Development
migrations and Edge deployment run only through `.github/workflows/deploy-dev.yml`;
production promotion is not authorized.
