# Internal Usage Notes

This file is excluded from the public GitHub repository. It documents features and workflows only relevant to New Relic employees.

---

## Staging Environment

Several features route to the New Relic staging API (`staging-api.newrelic.com`) when enabled. Staging is not accessible to external users.

### Setup wizard

The `preflight setup` wizard offers a third environment option:

```
Environment:
  1) US      — api.newrelic.com
  2) EU      — api.eu.newrelic.com
  3) Staging — staging-api.newrelic.com
  4) FedRAMP — api.newrelic.com (FedRAMP/GovCloud)
```

Select `3` or type `staging` to configure the MCP server against staging. The wizard generates a `--staging` flag in the hook and MCP config.

### Deploy commands

Both `preflight deploy-alerts` and `preflight deploy-dashboards` accept `--staging`:

```bash
node dist/index.js deploy-alerts --staging
node dist/index.js deploy-dashboards --staging
```

`--staging` and `--eu` are mutually exclusive.

### Terraform

To deploy dashboards and alerts against a staging account:

```bash
TF_VAR_account_id=... TF_VAR_api_key=... TF_VAR_staging=true terraform apply
```

The `staging = true` flag routes NerdGraph calls to `staging-api.newrelic.com/graphql`. The provider emits a deprecation warning for `nerdgraph_api_url` — this is expected.

See [ADVANCED.md](./ADVANCED.md) for full Terraform setup and teardown instructions.

---

## Syncing Shared Code

`src/shared/` is a vendored snapshot of the `nr-ai-typescript-shared` internal library. To update it:

```bash
npm run sync:shared
# or
npx tsx scripts/sync-shared.ts [--verbose]
```

The script requires `../nr-ai-typescript-shared` to exist as a sibling directory. It replaces `src/shared/` with a fresh copy of the upstream `src/` tree and prints a reminder to commit the result.

`scripts/sync-shared.ts` is excluded from the public repository.
