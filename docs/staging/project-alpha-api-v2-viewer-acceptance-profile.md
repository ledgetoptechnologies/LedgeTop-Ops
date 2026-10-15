# Project Alpha API-v2 plus Viewer staging acceptance profile

This separately reviewed, ignored Operations profile composes the existing exact
five-gate Project Alpha API-v2 window with the already approved live Viewer
integration and processing window. It does not change the existing five-gate
profile or either default-off source configuration.

The candidate enables exactly the five API-v2 flags documented in
`project-alpha-api-v2-acceptance-profile.md`, plus:

- `VIEWER_INTEGRATION_ENABLED=true`
- `VIEWER_PROCESSING_ENABLED=true`

Public shares and workspace-renewal CORS remain `false`. The profile rejects
all other config or resource drift and requires the staging Viewer identity:

- URL: `https://viewer-staging.ledgetopdroneservices.com`
- service key ID: `staging-v1`
- event key ID: `viewer-staging-v1`

Before use, independently compare those non-secret key IDs with the currently
approved live Viewer deployment. A mismatch blocks the window; do not change
the constants or candidate without a separate review.

Create the ignored `.backups/operations-staging-secret-names.json` as an object
with one `names` array containing exactly `VIEWER_SERVICE_HMAC_SECRET`. It must
contain no values or additional fields. This singleton is the authoritative
Viewer secret binding for the approved live window. Do not require or provision
`VIEWER_EVENT_HMAC_SECRET` while event delivery remains outside this window.
Never put secret values in this inventory, the generated config, command-line
arguments, Git, logs, or release evidence.

After the ordinary default-off config passes `staging:check` and the original
five-gate profile passes its own check, run:

```powershell
npm.cmd run staging:project-alpha-api-v2-viewer-acceptance:generate
npm.cmd run staging:project-alpha-api-v2-viewer-acceptance:check
```

The output is
`apps/operations/wrangler.staging.project-alpha-api-v2-viewer-acceptance.json`.
Review its diff from the base: only the seven allowlisted booleans and the
separately pinned live service key ID may change. The Viewer URL and event key
ID must remain byte-for-byte equal to the default-off source.
Use only that explicit config in the separately approved staging version
workflow and inspect the uploaded version's bindings before deployment. When
the bounded API-v2 window closes, restore the exact reviewed pre-window staging
Worker version/config: Viewer integration and processing must remain `true`,
the service key ID must remain `staging-v1`, and only the five API-v2 gates
return to `false`. Inspect its bindings and reverify the Viewer workspace launch.
Do not restore the ordinary default-off baseline, because that would disable
the already authorized Viewer integration and change its service key identity.
