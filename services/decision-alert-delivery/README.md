# Decision alert delivery

This service is the narrowly governed Slack destination adapter for material
human-decision blockers. It is separate from `slack-order-delivery`: it owns no
order candidate, prepared-message, route, work, attempt, or receipt relation.

`momi-decision-alert-delivery-v1` accepts only a private work UUID and one-time
capability token. Its database claim atomically verifies the default-off route,
exact development acceptance allowlist, destination, and capability, and
persists an attempt before returning any Slack payload. A network, server, or
receipt ambiguity is terminal pending operator review; it is never retried
blindly. A Slack `429` is the sole automatically retryable transport outcome
and honors bounded `Retry-After` evidence on a later Linear reconciliation.

The runtime secret is `SLACK_BOT_TOKEN`. The no-send `GET` probe reports only
whether that secret and the database connection are configured and whether the
private route is enabled; it never returns a value or sends a message.
