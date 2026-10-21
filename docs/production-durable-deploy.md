# Production deployment after the controlled onboarding rollout

The generic `apps/*/wrangler.jsonc` files remain install/development intent. Do
not use the direct CLI release command for these existing production Workers. Its
explicit defaults override operator-owned flags, it replaces the cron list,
and its current asset directory does not prove historical URL retention.

The production adapter is **not an installer or a cutover tool**. It requires
the completed, already active final-normal onboarding profile: all existing
resource IDs, current scalar names/value hashes, the Client→Ops recipient bridge,
the two capability-only observer bindings, and all10 Operations schedules.
Paused/diagnostic/maintenance/inactive-candidate profiles fail closed. It neither
enables flags nor creates bindings, grants, schemas, keys, schedules or assets.

## Cloudflare Git build settings

Keep automatic deployment disabled until this adapter has been reviewed and
the initial controlled rollout is complete. Root must replace each actual
dashboard deployment command; an npm wrapper does not change the dashboard's
existing direct CLI release command.

Set the build root to `apps/operations`, `apps/client`, or `apps/ops-sync` for
the corresponding Worker. Set the nonsecret **build** variable
`SKIP_DEPENDENCY_INSTALL=1`, then use this build command in each root:

```sh
npm ci && npm run build
```

Cloudflare otherwise detects the repository-root `pnpm-lock.yaml` and can run
`pnpm install --frozen-lockfile` in an application root that has only an npm
lockfile, failing before the configured command starts. The documented
[skip-dependency-install setting](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/#skip-dependency-install)
lets the explicit `npm ci` use each application's reviewed `package-lock.json`.
Apply it to the non-deploying environment diagnostic too; an installation
failure does not verify environment availability. Keep the repository lockfiles
and application build wrappers unchanged.

After the controlled rollout, use the matching guarded deployment command:

```sh
node ../../scripts/production-deploy.mjs --worker operations --mode backend --execute
node ../../scripts/production-deploy.mjs --worker client --mode backend --execute
node ../../scripts/production-deploy.mjs --worker ops-sync --mode backend --execute
```

`npm run build` remains the build entrypoint in each application root. Operations
and Client produce `dist/ledgetop_ops/index.js` and
`dist/ledgetop_clients/index.js`; Sync's Wrangler dry run produces
`dist/index.js`. Each module needs its genuine sibling `index.js.map`. The adapter
uses these exact layouts and does not fall back to a stale nested Sync bundle.

The only credentials accepted are the conventional build-environment
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The adapter does not search
credential files, call login, invoke a browser, or read the operator's MCP files.
Use the existing restricted production build token. The installed Wrangler
runtime must match the reviewed4.118.0 byte hash; dependency upgrades require
renewed qualification rather than silently changing deployment semantics.

The [official Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
documents a selected/generated build token but its default-variable table does
not promise these two environment variable names to arbitrary scripts. Do not
assume that the currently empty custom-variable UI is sufficient. Root must
configure the nonsecret `CLOUDFLARE_ACCOUNT_ID` and verify the conventional token
is available with the existing build authorization; if unavailable, configure
the existing authorized token as a build secret through its normal operator
path. No token is recovered from a hidden cache or created by this adapter.
Before restoring deployments run the following **non-deploying** build command;
it emits presence booleans only and makes no API call:

```sh
node ../../scripts/production-deploy.mjs --check-build-environment
```

The existing token needs metadata read access to all3 recognized Workers and
deployment access to its selected Worker. Token availability/permissions in the
actual Builds environment remain an execution prerequisite, not a claim made by
the offline tests.

Serialize production builds per Worker in the build system. All3 Workers may
otherwise roll code concurrently: unselected active/latest immutable versions
must both retain the exact recognized resources, scalar configuration and
locked asset association. Only their code/version/deployment identifiers and
Cloudflare's reserved `workers/message`/`workers/triggered_by` annotations may
progress; all custom annotations and protected controls remain fenced. Head
changes during an unselected capture allow at most2 extra GET captures, never a
native retry. Fresh metadata checks are not a distributed lock. If an upload or activation is uncertain,
preserve the original job/journal and reconcile current versions through GETs;
do not rerun a native mutation. An already active identical module is a read-only
no-op. An outstanding inactive latest version blocks the next deployment.

## What the command does

1. Check the committed frontend/build input fingerprint. Changed UI inputs or
   `--mode ui` stop before credentials or network access. Build the Worker first;
   the qualified `dist/<worker>/index.js` and genuine sibling map are required.
2. Read fresh official Cloudflare metadata for all3 production Workers, twice
   checking each active/latest head during capture. Require one100% active
   version, exact infrastructure/settings/exports/scalar hashes, the existing
   strict portal release profile, safe notification fields, bridge and crons.
3. Write an exclusive local `.backups/production-deploy/<worker>-<uuid>` journal.
   Compile `vars:{}`, `keep_vars:true`, name-only inheritance for every installed
   binding, the preserved full resource metadata and `keep_assets:true`. No
   current secret values are returned by the API or serialized into config.
4. Recheck current controls, run one native inactive `versions upload`, then
   verify the resulting immutable version's exact runtime JS, bindings,
   exports/runtime and opaque asset association. Current services and schedules
   must still match; a new version cannot silently overwrite an incomplete run.
5. Recheck controls, run a separate native `versions deploy <id>@100% --yes`,
   and verify the sole active/latest version, resources, assets and unchanged
   settings/schedules and protected controls on the other2 Workers. Native
   PID/log/exit journals remain. Returned source maps are compared semantically
   against the genuine input map, permitting only native relative-path/file
   normalization. If the API omits maps, receipts explicitly say they were not
   exposed; runtime verification is not mislabeled as returned-map proof.

The native child environment drops API-base/proxy/TLS/debug/Node injection
overrides and uses only the official Cloudflare API base. Logs stay local and
are not echoed. API reads have no retry, redirect following or mutation path.
The adapter never publishes triggers: all10 crons must already exist and remain
exact. Operator-owned flags, origins, notification cutoff/recipients and secret
bytes are inherited. The profile permits bounded valid recipient/cutoff changes
already made by their legitimate operator path; it never makes those changes.

## Frontend and profile updates

Backend mode retains the *existing opaque asset association*, including its
historical paths. It deliberately does not upload a newly built `dist/client`.
The committed fingerprint covers both frontends, their public files and build
dependencies/configuration, root package/lock files and shared source. A changed fingerprint is not
permission to update the lock: actual UI releases first need a reviewed union
of new assets and retained historical assets with URL compatibility checks.
Until that release path exists, UI changes fail with an actionable error.

The production profile contains resource metadata and scalar **hashes**, no
secret values or private credential paths. It was derived from the reviewed
original production controls plus only the approved final-normal additions.
It is a recognition policy, not evidence that those additions are currently
installed. A legitimate future resource/scalar/dependency change must update
this profile and tests in review; broad environment inheritance never turns a
fresh installation on by default.

Run local checks without credentials:

```sh
npm run production:deploy -- --check
npm run production:deploy:test
```

Tests use synthetic metadata/transport/native boundaries. Live provider
preservation and HTTP/business acceptance remain separate release evidence.
