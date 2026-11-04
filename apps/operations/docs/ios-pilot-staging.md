# iOS read-only pilot staging

The pilot uses the existing `LT Ops iPad OAuth Test` Access application on
`ios-pilot-staging.ledgetop.app`. The public edge Worker keeps the existing
synthetic `/oauth-probe/v1` sign-in diagnostic. The live facade starts disabled;
when explicitly enabled, it exposes only bounded `GET /mobile-pilot/v1/*`
operations reads. It calls the private
`IosPilotReadService` entrypoint through a service binding. The private Worker
has no public route and is bound only to the `ltds-ops-staging` D1 database.

The two dedicated Wrangler files are intentionally separate from the production
`wrangler.jsonc` and from the shared Operations staging Worker. Deploy the
private read service first, then deploy the edge Worker:

```powershell
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.ios-pilot-read-staging.jsonc
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.ios-pilot-edge-staging.jsonc
```

These deploys do not run D1 migrations and leave business reads disabled.
The isolated reader requires a configured connector source manifest; without
one, managed operations reads fail closed. The GET-only mobile facade uses the
manifest and D1 revision fence without loading snapshot or write-related quote
credentials. Provision the manifest through the approved staging configuration
process; do not copy any secret. Confirm that configured sources match the
authorized staging registry, schema, and both Access audiences before enabling
the live flag. The public Worker must continue to receive the
dedicated Access application context, and the signed assertion identity must
match it. A successful synthetic probe alone does not validate the private data
path. Do not enable the iOS live workspace until the reviewed backend and client
revisions are deployed and the authenticated session, list, detail, pagination,
permission-denial, and restart checks pass.

No production Worker, production database, or production Access application is
used by these configurations.
