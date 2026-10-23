# Local .NET → Client → Ops RPC transport acceptance

The opt-in `apps/client/vitest.workerd-rpc-transport.config.ts` exercises the
existing .NET `TransportTests` executable over ephemeral loopback HTTPS. The
harness forwards each request to a real local Workerd Client Worker. Its native
authorization reader is the actual Ops named WorkerEntrypoint through a Miniflare
service binding, backed by separate local D1 databases and an R2 emulator.
No direct function reader adapter supplies the authorization response. A Node-only
platform-base stub allows host-side provisioning imports; fresh esbuild Worker
bundles retain the real cloudflare:workers module and are not Vitest-mocked.

This reuses the same bounded 2 MiB synthetic `map.bin` payload and real Ops
synthetic-authority provisioning as the earlier transport acceptance. The
multiworker fixture owns Worker construction, synthetic RS256/JWKS setup,
canonical migrations, authority provisioning and Ops-only revocation. The TLS
harness owns only ingress header injection, one deliberate network interruption,
the synthetic revoke control route and the unchanged .NET child.

The child verifies the exact ephemeral certificate pin, refusal of an altered
RS256 assertion, authorized catalog/manifest parsing, interruption before file
publication, Range resume and SHA-256, followed by refusal of the saved download
handle after Ops revocation. The Client grant remains active: this negative must
cross the Ops RPC boundary rather than rely on client-side grant deletion. The
recorded download statuses must be 200, 206, 404 and the resumed Range must start
at the actual prefix retained by the .NET downloader. The Client content-start
audit is checked in D1.

Run explicitly from `apps/client` with installed dependencies matching the
checked-in lockfile and the exact SDK selected by the Windows `global.json`:

```powershell
$env:LEDGETOP_TEST_DOTNET = 'C:/Users/fstor/.codex/cache/windows-download-dotnet-10.0.402/sdk/dotnet.exe'
node node_modules/vitest/vitest.mjs run --config vitest.workerd-rpc-transport.config.ts
```

`LEDGETOP_TRANSPORT_RECEIPT` optionally names a new caller-owned receipt file;
creation is exclusive. Receipts contain lengths/digests/statuses and bounded
claims, never assertions, private keys or byte handles. Ephemeral certificates,
keys, synthetic assertions and owned output are removed after the test. No OS
trust store or global TLS policy is changed. HTTPS listens only on 127.0.0.1.

This is local emulator and synthetic-identity acceptance. The virtual staging
host and local Access-ingress equivalent are test seams. It does not prove human
sign-in, a deployed Cloudflare service binding, real R2, protected Engineering Hub
execution, employee gateway/container acceptance, or NAS behavior. Production
origins/authentication and live deployment gates are unchanged.

## Qualification receipt (2026-10-22)

The full layered acceptance passed **1/1**, 81.35 seconds test / 82.77 seconds
total, using .NET SDK 10.0.402 and the actual full Ops composition. The unchanged
.NET child and all Node assertions above passed. Prerequisite source commits:
`4b837e02` (runtime export policy) and `578bc344` (real multiworker fixture).
No reader-only diagnostic host is accepted by this harness.
