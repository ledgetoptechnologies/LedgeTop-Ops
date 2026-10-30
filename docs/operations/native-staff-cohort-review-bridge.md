# Retained Operations cohort-review bridge

This source lane prepares a narrowly scoped, offline bridge for the existing
read-only `POST /api/staff/current-cohort-review` route. The bridge runs a
standalone Hono app for that method and path and delegates every other fetch,
queue, and scheduled call to the retained Operations Worker. It is dormant
source preparation; it does not change the active Worker or grant authority.

## Retained runtime contract

The package builder copies only the three named retained modules. It checks
their file types and lengths before reading, then verifies their SHA-256 pins:

- `index.js`: 6,884,992 bytes, `7973278da1b6c3958a3071bf639f61f4dfbe8a224099a62881e9704fd2fa8760`
- `__ops_c880_retention_ledger.json`: 66,973 bytes, `ccee26957c3c99ff28a1f4c4d6c5a29c6ce97033fd5978f00d1a5b3422c155aa`
- `__ops_release_ledger.json`: 60,961 bytes, `29c66e83afb37a9a2952c8606318949a5ee9ee05a62b3e8c8bb0e29c14080b1d`

The builder parses the retained `index.js` bytes with esbuild's ESM metafile
generation without importing or executing the old Worker. It compares the
derived export inventory with the reviewed 797-runtime inventory and records
the derived names in the receipt. The candidate adds `wrapper.js`; the old
module and both ledgers remain byte-identical. The receipt is not a Worker
module. The wrapper's `node:crypto` import relies on the existing
`nodejs_compat` flag.

Build a local review package with a new output directory and a directory holding
the independently captured exact modules:

```powershell
node scripts/native-staff-cohort-review-bridge-build.mjs `
  --retained-dir "<exact-retained-module-directory>" `
  --output-dir "<new-offline-review-directory>"
```

The package is not an upload command. A later release must inherit and verify
the existing bindings, secrets, compatibility date and flags, schedules,
routes, and asset configuration and bytes. Its only entrypoint change is to
select `wrapper.js`; the module upload contains that wrapper and the three
verified retained modules. Do not upload the receipt as a module.

## Qualification limits

The focused source tests check exact routing, handler delegation and error
identity, the retained module pins, export-parser mismatch cases, source/output
path fencing, and bundle closure. The separate synthetic `0225` route tests
cover the current route's owner/denial/drift and no-write behavior. These tests
do not execute the Worker on Cloudflare. A candidate still needs a packaged
Worker runtime qualification and a separately reviewed release; source tests
and a green CI run do not establish runtime readiness or authorize activation.

The locked local Miniflare rejected both the retained baseline and the wrapper
at startup on the string export `NATIVE_DIRECTORY_OUTBOX_CRON`. That comparison
does not establish a wrapper regression or production behavior. Do not remove
exports or invent Workflow bindings to make the harness start. Production's
declarative export metadata and its actual named handlers are distinct from
the full JavaScript export inventory and must be preserved during qualification.

## Inactive upload preparation

`createNativeStaffCohortReviewBridgeUploadPlan` in
`scripts/native-staff-cohort-review-bridge-upload-plan.mjs` accepts an already
captured, in-memory Operations snapshot and the absolute candidate directory.
It does not read credentials, contact a provider, upload a version, or activate
one. Persist only its `safeSummary`; its metadata draft and module descriptors
are review data, not an executable uploader or Wrangler configuration.

The finite installed profile recognizes version
`0b1ab5a8-9db0-42ab-b718-8569fae2382e`, including the two already-installed
direct Viewer session methods. It preserves the existing production profile
and has its own provenance and hash pin. The asset profile explicitly records
the observed root path and automatic trailing-slash handling, rather than
accepting arbitrary default normalization. Its Git attributes fix LF endings
so its byte pin works across operating systems.

The planner requires matching active/latest/modern versions and a single
100-percent deployment. It verifies the installed settings, scalar digests,
resource bindings, handlers, runtime, schedules, asset configuration, and all
three original module bodies and types. Candidate receipt and wrapper pins are
independent of the candidate's own claims. The ledger modules retain
`text/plain`, despite their `.json` filenames; an uploader must not infer JSON
module types from their extensions. Upload preparation keeps the complete
reviewed metadata and inherits existing bindings, with no migrations.

On October 30 at 01:50 UTC, a fresh GET-only capture passed these checks against
the installed Worker and the candidate package. This establishes preparation
compatibility, not provider acceptance, request execution, or live readiness.
The readback receipt is
`release-records/unification-20261024/root-cohort-upload-plan-live-read-20261030.json`
in the local release records. No raw settings or secret values were saved.

Run the artifact-independent checks with:

```powershell
node --test scripts/native-staff-cohort-review-bridge-upload-plan.test.mjs
```

Two tests require the separately captured package. Set
`COHORT_BRIDGE_CANDIDATE_DIR` to the reviewed candidate directory to include
them. Without that path those cases are explicitly skipped; the ordinary
source check is not evidence of package qualification.

Cloudflare does not provide Version URLs for this Durable Object Worker. An
inactive upload and complete metadata readback can still establish provider
acceptance without activation. A later reviewed executor must preserve exact
module content types, use strict binding inheritance, record its intent before
dispatch, reconcile an ambiguous result without replaying the upload, and
prove that the active deployment did not change. That executor is not part of
this planner. A successful upload alone is not a request-time behavior test.

The separately reviewed `native-staff-cohort-review-bridge-inactive-upload.mjs`
library implements that one-shot protocol. Its production path always captures
the fixed Operations endpoints and checks the pinned package. A test-only plan
substitution exercises protocol failures with a fake API; a live caller must
not supply test hooks. Intent persistence failure blocks dispatch, and an
uncertain response never causes another POST. Accepted candidate IDs are
recorded before readback; a journal failure requires GET-only reconciliation.
The executor exposes no activation, migration, permission, or settings writer.

Uploading an inactive version advances the Worker’s latest-version head. This
does not change active traffic, but it can block generic deployment tools until
the known candidate is reconciled. Preserve its journal and do not describe the
installation as having a clean release head after upload. This retained-code
bootstrap path adds only the owner read-only review prerequisite; it cannot
replace the native staff handoff required by a full Operations or Sync release.
