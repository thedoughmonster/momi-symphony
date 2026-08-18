# Compatibility contracts

The repository move preserves these contracts without changing their semantics:

- signed Linear webhook normalization and action catalog;
- private database claim, retry, cancellation, recovery, terminal, and write-back routines;
- authenticated host dispatch, cancel, and recovery payload schemas;
- one host ledger identity per work ID;
- `GET /health` returning `{ "ok": true, "service": "momi-agent-control-host" }`;
- durable Linear comments and label write-back;
- existing callback and private tunnel boundaries.

Slack decision-alert behavior is owned by MOX-232 and is not implemented by this repository-transfer change.

## Downstream extension seams

MOX-234 remains downstream of this repository transfer. This foundation keeps
its later work contract-neutral and does not implement it:

- action-specific instruction assembly stays separate from durable dispatch
  transitions, so a later context assembler can vary by action;
- the private database remains the full-artifact authority while any future
  model-visible tool evidence must be explicitly bounded;
- the host ledger preserves exact work, thread, and turn identities so a later
  checkpoint-plus-delta continuation does not require full transcript replay;
- cancellation, recovery, claim, retry, and write-back remain deterministic
  phase handlers, and structurally deterministic operations must not require a
  model task;
- future execution budgets and token, turn, tool, and retry telemetry attach to
  the durable work identity through additive modules or fields, without changing
  the current dispatch, host, or callback contracts.

This review adds no compaction, checkpoint, budget, telemetry, or MOX-234
acceptance behavior.
