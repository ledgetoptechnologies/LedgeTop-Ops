# Preparing an inactive staging version without reconstructing resources

`scripts/windows-files-staging-inherited-upload.mjs` is a pure offline adapter.
It has no cloud transport, filesystem access, credential reads or execution
command. Its output is private preparation material, not release approval.
Production configuration and release policy are outside its scope.

`prepareWindowsStagingInheritedUpload(input)` takes the existing composition and
live-variable inputs plus paired `snapshotRefs.operations` and `.delivery`:

```js
{
  accountId: stagingAccountId,
  workerName: observedWorkerName,
  latestUploadedVersionId: observedVersionId,
  activeDeployment: { versions: [{version_id: observedVersionId, percentage: 100}] }
}
```

Both apps must have one fully active version, matching the supplied latest
uploaded version and the existing preflight/version-detail pins. These supplied
observations establish consistency only; they are not independent physical
verification or a lock. Re-read them immediately before any separately authorized
upload. Cloudflare script-version inheritance uses the latest **uploaded**
version, which can differ from the deployed version.

The original composition checks still run. Current plain-text variables replace
template values via the existing preservation step. The minimal upload configs
contain generated main, identity, compatibility date/flags, full vars and an
`unsafe` block. Compatibility dates and baseline flags remain unchanged except
the original enabled composer's documented Ops `enable_request_signal` append.
That explicit addition is permitted only through the existing enabled-profile
admission checks; no separate flag deployment is required. The inactive version
must match the exact composed flag list. Other changes refuse. Configuration migrations,
legacy Sites, and caller unsafe overrides refuse.

Every existing non-plain binding is explicitly inherited by name, including old
secret names, assets, workflows, email, rate limits and other supported types.
The adapter does not reconstruct their policy. `unsafe.metadata.keep_bindings`
is an empty array to override Wrangler 4.118's broad unchanged-secret inheritance;
only explicit names are intended. Secret records contain names and types only;
secret values are neither needed nor accepted. Provisioning the dedicated new
Windows key slots is a separate gate, never satisfied by this receipt.

Runtime metadata is limited to the observed staging shapes: standard usage,
known existing worker and SQLite Durable Object declarations, existing Ops
container class names, and Client positive integer CPU/subrequest limits. Unknown
fields, changed class declarations, export lifecycle states, transfers, deletes,
renames and new resources refuse. No local container/image declarations are
emitted, so this is not a container rollout plan.
The observed Ops Durable Object binding must also be exactly the existing
`THUMBNAIL_RENDERER`/`ThumbnailRendererContainer` with a 32-character lowercase
hex namespace ID and no external script/environment fields. Missing or extra
bindings refuse; Client admits no Durable Object binding. This is snapshot
consistency, not independent verification of namespace ownership.

No local `assets` section or directory is emitted. `keep_assets: true` reuses the
existing asset set. A config-only metadata assets object preserves the understood
route policy: `raw_run_worker_first` maps to `run_worker_first`; its derived
`static_routing` must agree and is not posted. API omission of an empty routing
array and Wrangler's explicit empty-array representation are lossless for this
input validation only; the final raw inactive runtime comparison remains exact.
`base_path`, `not_found_handling` and optional `html_handling` map unchanged.
The deprecated observed `serve_directly` boolean is validated but omitted from
request metadata when explicit `run_worker_first` is emitted. Cloudflare rejected
posting both with HTTP 400/code `10021`; the observed `true` value is not grounds
for rejecting an otherwise consistent baseline. This is request serialization
only: the entire raw inactive assets/runtime object, including `serve_directly`,
must still exactly match the baseline before any separate activation. A missing
or changed readback field holds the candidate; no reconstruction is assumed. This mirrors the
repository's existing production adapter pattern without reusing its policy or
values. No asset JWT or files are uploaded by this module.

Promotion configs contain only Worker name and account ID. Neither config emits
routes, cron, observability, tail consumers, logpush, queue consumer policy, or
other non-versioned settings. They are intended only for separate version-upload
and version-deploy operations, never generic `deploy` or trigger publication.

`compareWindowsStagingInheritedCandidate(input, candidateVersionDetails)` must
receive actual inactive-version responses. It revalidates preparation and
requires the complete runtime object, including full assets routing, and every
non-plain binding/policy to match the baseline. Plain variables must match the
prepared full map. A different inactive version ID is required. A mismatch holds
the candidate: do not invent defaults or retry promotion. Even a matching result
does **not** prove the opaque asset association, uploaded code, authorization,
freshness or non-versioned settings. Those require independent release checks.
Neither function authorizes upload or activation.

Errors and receipts never include private values or per-variable hashes.
Returned configs contain actual values and must not be committed or printed.

Verified implementation references:

- Installed Wrangler **4.118.0** `createWorkerUploadForm` and `versionsUpload`:
  unsafe binding passthrough, final metadata override, strict name inheritance,
  and config-only metadata without local asset sync.
- [Cloudflare asset direct upload metadata](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Cloudflare inheritance rules and latest-version behavior](https://developers.cloudflare.com/workers/observability/errors/)
- [Cloudflare version upload runtime and declarative export schema](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)

Focused verification:

```powershell
node --test scripts/windows-files-staging-inherited-upload.test.mjs scripts/windows-files-staging-live-vars.test.mjs
```
