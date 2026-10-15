# Paired end-to-end staging acceptance composition

## Live staging preservation gate — 2026-10-08

Do not deploy the baseline pair directly over the current live staging
configuration. Read-only Wrangler inspection of the active Operations version
`5f0ad270-0092-4f51-9534-34efc6ee2957` confirmed
`VIEWER_PUBLIC_SHARES_ENABLED`, `CLIENT_VIEWER_SESSION_ISSUER_ENABLED`, and
`CLIENT_VIEWER_SHARES_ENABLED` are all `"true"`. The default-off baseline below
would reset those existing settings. The active Client version
`8bf70f8c-c3c5-494d-8c4b-474427f86350` has `CLIENT_VIEWER_ENABLED` and
`CLIENT_VIEWER_SHARES_ENABLED` both `"false"`; preserve those values too, rather
than treating a historical approval as proof of current deployment state.

These are observations, not immutable deployment locks. Recheck the active
versions and selected settings immediately before staging deployment, compare
all unrelated bindings/settings as well, and reject stale snapshots or
unreviewed differences. Do not infer an invented `VIEWER_CLIENT_ACCESS_ENABLED`
setting: the canonical runtime names are the explicit flags above. No production
configuration or existing public link is part of this preservation task.

The pure `scripts/staging-paired-live-settings-preservation.mjs` overlay validates
the original pair internally and accepts only the reviewed staging Worker names,
versions and five selected boolean values. Its independently supplied active
version preflight must agree with that snapshot; the resulting configuration
must equal the validated baseline plus exactly those preservation values. It
performs no remote reads, writes or deployment. The caller must obtain the
preflight from current authoritative deployment metadata, not reuse the saved
snapshot as its own freshness proof. This checks only five variables: full
unrelated configuration/binding comparison remains required before deployment.

## Default-off baseline composition

This pure profile composes the reviewed Operations API-v2, live Viewer, and
Directory-adoption and UI-only native Directory-write windows with the paired native-workspace and native
service-home profiles. Every constituent builder validates the same untouched
default-off Client and Operations sources; the composer merges only their
exported flag deltas and then requires full-object equality for both candidates.
The pure composer performs no file writes, network calls, or deployment. Its
dedicated local CLI can materialize or verify one ignored, indivisible pair:

```powershell
node scripts/staging-paired-end-to-end-acceptance-cli.mjs --write
node scripts/staging-paired-end-to-end-acceptance-cli.mjs --check
```

The Directory-write constituent is required for the normal `/clients` create
and update UI. It enables only `NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED`;
`NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED` remains false and grants are not issued
by configuration. After the exact synthetic command is created, review global
profile/relationship outboxes and waiting client intents before a separately
bounded drain window. The drain is not actor-scoped and could process older
work. Save paired authority recovery evidence and restore drain=false after
sync testing. Both gates remain default-off in source and production baselines.

The CLI reads the validated default-off staging and production configurations
plus the names-only `.backups/operations-staging-secret-names.json` inventory.
It writes only
`apps/client/wrangler.staging.paired-end-to-end-acceptance.json` and
`apps/operations/wrangler.staging.paired-end-to-end-acceptance.json`, with
private file permissions. It never overwrites an existing candidate, rejects a
missing, partial, stale, symlinked, non-ignored, or escaped pair, and performs
no deployment, network request, credential read, or production mutation.

The pair is indivisible: missing Client or Operations configuration, an omitted
gate, an extra variable/resource, changed URL or Viewer key, an invalid
names-only Viewer secret inventory, or an enabled production API, Directory,
workspace, or native-portal acceptance gate fails validation. Each constituent
retains its own production default-off checks; the composition does not change
or reinterpret the existing production Viewer configuration. Staging Viewer
integration and processing remain true with service key `staging-v1`; public
shares remain false. All bindings, routes, resources, and other default-off
gates remain equal to their validated sources.

Local verification passes all six composition tests. A separate in-memory run
against the real validated baseline also built and validated the pair without
mutating its inputs; the resulting diff contained exactly three allowed Client
variables and fourteen allowed Operations variables. These are local tooling
results only, not evidence of a remote upload, deployment, or live acceptance.

Before any separately authorized staging use, review the individual profile
prerequisites and the full pair diff. These scopes remain independent from
recipient enrollment, recipient/file grants, automatic matching, client access,
and public-link creation. Existing links must remain unchanged. A valid composed
candidate does not prove complete acceptance and does not authorize upload,
deployment, migration, enrollment, or production rollout.
