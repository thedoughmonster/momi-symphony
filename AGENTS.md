# Agent Control Rules

- Accept only the declared action catalog; `has-run` is output only.
- Verify Linear signatures over untouched bytes before trusting parsed fields.
- Normalize label changes only from `updatedFrom`, never the full issue object.
- Keep `momi_agent_ops` private and expose no Data API relation or routine.
- Never log raw Linear payloads, capability tokens, API keys, or task prompts.
- Project mappings come from the owned table and fail closed when absent.
- A dispatch may create at most one Codex thread; ambiguous starts stay blocked.
- Archive only after a terminal App Server turn notification is observed.
- Parent coordination may create child work only through durable `execute-run` labels.
- Never invoke Symphony from this service or its host adapter.
- Cancellation must distinguish queued, active, terminal, and ambiguous host states.
