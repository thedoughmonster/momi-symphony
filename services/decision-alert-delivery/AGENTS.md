# Decision Alert Delivery Rules

- Deliver only work claimed through the private `momi_agent_ops` capability boundary.
- Never read or write the order-alert Slack dataset or widen its contracts.
- `SLACK_BOT_TOKEN` is a runtime secret: never log, return, or persist it.
- Reject destinations outside the exact private decision-alert allowlist.
- Persist an attempt before Slack I/O; ambiguous delivery is terminal pending operator review.
- Never expand `@channel`, `@here`, user, or user-group mentions.
- Resolution is a single reply to the receipt recorded for the same Linear decision identity.
