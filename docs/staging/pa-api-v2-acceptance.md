# Project Alpha API v2 staging acceptance

This runner is an operator-only release check. It calls a Project Alpha
staging instance directly; it is not mounted in an Operations Worker and is
not a production synchronization path.

Run the default-off baseline without credentials:

```powershell
$env:PA_ACCEPTANCE_BASE_URL = 'https://pa-staging.example.test'
$env:PA_ACCEPTANCE_MODE = 'baseline'
npm run staging:pa-api-v2:acceptance
```

The mutating mode refuses to start unless all of the following are true:

- `PA_ACCEPTANCE_ALLOW_MUTATIONS=allow`
- `PA_ACCEPTANCE_PREFIX` starts with `pa-acceptance-`
- a dedicated, application-bound, non-`full` API key is supplied through
  `PA_API_TOKEN`
- source, application, and history UUIDs are supplied through
  `PA_SOURCE_INSTANCE_ID`, `PA_APPLICATION_ID`, and `PA_HISTORY_EPOCH`
- an application-bound organization proof is supplied as the exact JSON wire
  shape through `PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON`

Set `PA_ACCEPTANCE_ALLOW_LIFECYCLE=allow` and provide the reviewed disposable
fixture JSON only when the archive and restore flags/scopes are enabled. If
Cloudflare Access protects the staging ingress, provide its service credential
through `PA_CF_ACCESS_CLIENT_ID` and `PA_CF_ACCESS_CLIENT_SECRET`; do not put
either value in a command, fixture, report, or repository.

The automated project sequence covers create, exact replay, changed-body
command conflict, exact read, profile update, update replay/conflict, binding
status, inventory consistency, and optional archive/dark restore. Output is
limited to statuses, request IDs, permanent IDs, revisions, generations,
hashes, presentation booleans, and pass/fail. It never prints the bearer token
or returned profile bodies.

The runner deliberately leaves three browser-assisted checks explicit:

1. Edit the bound fixture through the ordinary PA browser, confirm the pinned
   binding/update conflicts, then perform and replay a binding revision refresh.
2. Enable a disposable public Project link in the browser, confirm archive
   makes the retained URL return 404, and confirm restore leaves it dark until
   an authorized browser user deliberately republishes it.
3. Disable the temporary PA feature flags and prove capabilities no longer
   advertise the routes while ordinary browser editing still works.

Preserve receipts, history, bindings, and audit records after the rehearsal.
Archive the disposable Project rather than deleting it. Record only sanitized
evidence in the migration plan.
