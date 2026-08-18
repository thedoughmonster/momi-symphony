# Migration authority handoff

The development database contains seven applied `agent-control` migrations.
Their exact byte hashes are pinned in `config/migration-baseline.json` and tested
in CI. The same files remain unchanged in `momi-backend` so its historical
migration ledger is never rewritten.

After the repository cutover:

- this repository is the sole authority for every new `momi_agent_ops` migration;
- `momi-backend` rejects new migrations owned by `agent-control`;
- only this repository's manual development workflow may apply those changes;
- production contains no `momi_agent_ops` schema or matching migration versions;
- production activation requires a separate approved issue.

The cutover is compatible rather than a data copy: development continues using
the existing private schema, functions, four durable tables, and recovery job.
No row identity changes. Pre-cutover reconciliation recorded 2 project mappings,
788 webhook envelopes, 39 dispatches, 39 run records, and 1 recovery job.
