# Local Workerd service-binding acceptance

The opt-in paired fixture bundles the full existing Ops staging Worker and
Client Worker with their actual Windows staging factories. It exports the
reviewed16 Ops and13 Client runtime classes and audits them against the raw
source export inventories using `windows-files-staging-exports.mjs`. Default
fetch/queue/scheduled handlers remain delegated through the actual factories.
No production source or deployment configuration changes are included here.
The export-policy fix must be integrated first.

This acceptance discovered a real runtime gap in the earlier static-only build:
raw `export *` exposed Ops cron string constants, and Workerd rejected
`NATIVE_DIRECTORY_OUTBOX_CRON` as an invalid runtime entrypoint. Root's separate
policy fix classifies module helpers and emits only reviewed runtime exports.
The final fixture uses the full corrected compositions; it has no narrower
reader-only success mode. Actual Workerd startup is part of the regression.

## What actually runs

- Miniflare runs the real bundled
  `OperationsPortalNativeDeliveryAuthorizationReader extends WorkerEntrypoint`.
- The Client's `OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER` is a
  real service designator `{name, entrypoint}`, not a function replacement.
- A separate local probe Worker invokes the same named reader over Workerd RPC
  for direct allow/disabled/malformed/denied protocol checks. Its HTTP interface
  is local test code, not a mounted Ops endpoint.
- Ops D1 uses the fixture's pinned complete canonical224-migration chain.
  Existing native directory, publication, recipient and delivery commands set
  up and revoke authority. Client uses real local D1 and R2 with2MiB map.bin.
- The actual composed Client HTTP catalog consumes a locally signed RS256
  assertion, verifies it through its unchanged identity code, and obtains its
  authority over the actual service binding. Only the exact expected issuer's
  `/cdn-cgi/access/certs` GET receives the synthetic public key through an
  outbound-service interception. Every other outbound destination is denied;
  there is no network fallback or real Access login.
- Ops-only revoke leaves the Client consumer grant active. Subsequent private
  RPC and Client catalog reads deny it (Client404).

The existing Node-side setup helper imports a publication entrypoint platform
class, so the test supplies a Node-only `cloudflare:workers` base shim for that
bootstrap import. No jose or authority-reader mock is installed. esbuild reads
source files directly, without Vitest transforms/plugins, and the Workerd module
resolves its real platform base. This shim cannot replace the actual bundled
named reader. Owner/admission bootstrap rows and PA outbox acknowledgment remain
synthetic setup; no PA round trip or Workerd RPC writes are claimed.

## Run

From `apps/client`:

```
node node_modules/vitest/vitest.mjs run --config vitest.workerd-rpc.config.ts
```

This is explicitly excluded from ordinary test discovery. It starts local
Workerd processes and temporary Miniflare D1/R2 state, then disposes the whole
runtime in finally. Fixture setup failure also disposes it. No cloud commands,
credentials, staging server, NAS, migrations against remote databases or
Engineering Hub execution are involved.

The pinned local Miniflare/workerd dependency graph supports a local
compatibility date through2026-08-06. The fixture deliberately uses that date and
`nodejs_compat` without upgrading dependencies; this is not proof of a newer
cloud runtime configuration. Declared staging metadata is local synthetic
configuration and not a fresh observation of remote physical resource ownership.

Direct probe counters count only explicit probe calls, not all RPC traffic from
Client. Denied HTTP status does **not** independently prove zero R2 reads; there
is no R2 read instrumentation in this fixture. Bundle SHA/export inventories
identify local test output only, not deployed versions. The fixture exposes its
actual Client fetch and synthetic token for the separate opt-in TLS/.NET
transport acceptance; this document does not claim that transport run until its
separate receipt passes. No remote/deployed RPC, real human session, employee
server, signing, installation or Explorer Cloud Files acceptance is implied.

Official references checked October22:

- [Miniflare multiple Workers](https://developers.cloudflare.com/workers/testing/miniflare/core/multiple-workers/)
- [Named WorkerEntrypoint RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
