# Material decision alert operations

## Durable Linear record

An issue is eligible only when it has the `blocked-external-decision` label and
exactly one whole top-level comment in this form:

````markdown
momi-decision:v1
```json
{
  "decision_key": "stable-bounded-key",
  "category": "material_architecture_ownership",
  "status": "unresolved",
  "question": "A concise sanitized human decision question.",
  "policy_gap": "Why current repository and issue policy cannot decide it.",
  "recommendation": "The agent recommendation.",
  "alternatives": ["One viable alternative"],
  "consequences": ["One material consequence"],
  "affected_issue_identifiers": ["MOX-232"],
  "resolution_summary": null
}
```
````

The record is intentionally strict. Never paste a task prompt, provider body,
credential, token, protected context, Slack mention, or unbounded evidence into
it. To resolve, edit the same comment to `status: "resolved"`, add a bounded
`resolution_summary`, and remove `blocked-external-decision`. A replacement
comment creates another identity and cannot resolve the first alert.

## Default-off gates

1. Confirm production ref `viodfldzuoypnpqaagag` is not selected.
2. Confirm scheduler route disabled, host scheduler false, zero active slots,
   and zero nonterminal scheduler work.
3. Confirm exact protected main SHA and exact-main CI.
4. Run the development deploy preflight; it must report exactly one pending
   private migration with matching checksum and no write.
5. Apply that exact migration through `Deploy development`; read back the
   private ledger, RLS/revokes, and `decision_alert_policies.mode='disabled'`.
6. Deploy only the webhook and decision-alert functions at the exact SHA.
7. Invoke the decision adapter `GET` probe. It must prove the database and
   `SLACK_BOT_TOKEN` are configured while `send_enabled=false`. It exposes no
   secret value.
8. Resolve the exact existing development destination through Slack immediately
   before acceptance. Do not use customer-facing channels and do not include
   `@channel`, `@here`, users, or user groups.
9. Configure `acceptance` mode only with the exact issue UUID, exact protected
   SHA, destination key, and freshly verified channel ID.

## Controlled acceptance

Use one current development Linear issue only. Create the bounded unresolved
record and blocking label through Linear. Prove one initial receipt after
duplicate comment/issue events and reconciliation. Negative fixtures for every
excluded category must leave attempt and Slack message counts unchanged.

Resolve only by editing the same Linear comment and removing the blocking
label. Prove one reply on the initial thread, one resolved lifecycle, and a
later normalized issue read that preserves the ready attestation. Decision-alert
eligibility owns the blocking label; the scheduler no longer treats that legacy
label as a second readiness gate.

If Slack returns `429`, respect `Retry-After` and do not switch tools. If the
request or receipt is ambiguous, stop without retry and preserve the evidence.
In all outcomes immediately call `disable_decision_alert_delivery_v1()` and
read back `mode='disabled'` with an empty acceptance allowlist.

## Rollback

Run `ops/sql/disable_decision_alert_delivery.sql`. Do not delete decision,
work, attempt, receipt, or Linear evidence. Re-deploy the previously recorded
function hashes only when rollback of runtime code is necessary. Production
remains untouched.
