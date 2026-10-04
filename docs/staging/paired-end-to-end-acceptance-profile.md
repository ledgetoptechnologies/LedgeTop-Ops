# Paired end-to-end staging acceptance composition

This pure profile composes the reviewed Operations API-v2, live Viewer, and
Directory-adoption window with the paired native-workspace and native
service-home profiles. Every constituent builder validates the same untouched
default-off Client and Operations sources; the composer merges only their
exported flag deltas and then requires full-object equality for both candidates.
The pure composer performs no file writes, network calls, or deployment. Its
dedicated local CLI can materialize or verify one ignored, indivisible pair:

```powershell
node scripts/staging-paired-end-to-end-acceptance-cli.mjs --write
node scripts/staging-paired-end-to-end-acceptance-cli.mjs --check
```

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
