# Agent Control Host Rules

- Accept only authenticated canonical dispatches from `agent-control`.
- Reserve a work ID durably before any App Server start request.
- Never retry an ambiguous thread or turn start automatically.
- Never log instructions, capability tokens, bearer secrets, or App Server items.
- Validate repository and base branch against host configuration.
- Archive only after the exact accepted turn is terminal.
- Retry only the idempotent terminal callback; do not create another task.
