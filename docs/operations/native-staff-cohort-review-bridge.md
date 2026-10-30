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
