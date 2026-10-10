# Native workspace acceptance candidate CLI

This local-only wrapper renders the existing three-gate native workspace acceptance profile into ignored candidate configs. It never deploys, reads secrets, or changes the default staging or production configs.

First render and validate the ordinary default-off staging configs. Then run:

```text
node scripts/staging-native-workspace-acceptance-cli.mjs --write
node scripts/staging-native-workspace-acceptance-cli.mjs --check
```

The two outputs are:

- `apps/client/wrangler.staging.native-workspace-acceptance.json`
- `apps/operations/wrangler.staging.native-workspace-acceptance.json`

Both paths must already be ignored. `--write` creates a missing candidate atomically and leaves an exact existing candidate untouched. It refuses malformed, stale, edited, nonignored, or symlinked inputs and outputs rather than overwriting them. `--check` requires both candidates and recomputes them from the current default-off staging inputs and production defaults.

The candidate changes only `CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED`, `OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED`, and `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED`. Review and deploy the pair together through the normal staging process; this command performs no remote action.
