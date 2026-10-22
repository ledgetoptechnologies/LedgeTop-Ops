# Local Windows client transport acceptance

This opt-in acceptance adds a real network boundary to the Windows prototype.
It uses the actual .NET `PortalClient` and `Downloader`, the existing Client
catalog and successor router factories, real local Miniflare D1/R2, and the
existing Client publication, recipient-grant, delivery-grant/revoke and mandatory
content-start audit consumers. It changes no product code or deployment settings.

The source base is PR #236 commit `2cc7dcdd`; test source is isolated on
`codex/windows-real-transport-20261022`. The neighboring JSON receipt records
observed assertions, not approval for deployment or installation.

## Run on the PC

Use Node dependencies from the Client lockfile and the Windows project's exact
.NET SDK from `apps/windows-download/global.json` (currently `10.0.402`). No
additional NuGet sources are enabled. From `apps/client`:

```powershell
npm ci --ignore-scripts
# Set this only if the reviewed SDK is not on PATH; use its real local path.
$env:LEDGETOP_TEST_DOTNET='C:/path/to/dotnet.exe'
npx vitest run --config vitest.transport.config.ts --reporter verbose
```

The explicit transport config keeps listeners and .NET subprocesses out of the
ordinary Client unit-suite discovery. `LEDGETOP_TRANSPORT_RECEIPT`, when supplied,
must name a new caller-owned output file; the harness refuses to overwrite it.
The receipt contains no certificates, private keys, tokens or selectors.

## What this proves

The .NET process parses an actual catalog, folder and download manifest. It
validates a 2 MiB synthetic file with SHA-256
`91d6f139837323de3829070b54945b770230a2fbfd270b370184b57305bfaf65`.
The loopback TLS adapter drops the first authorized content response after
16,384 bytes; the downloader retains that uncommitted prefix, then sends an
actual HTTP Range request at its saved offset. The actual successor route
returns `206`, and the .NET downloader verifies the final digest before
publishing the file. The original request was `200`.

The harness then applies `delivery.revoke` through the real D1 authority
consumer. Reusing the previously valid manifest produces `404`, no additional
R2 reads and no published file. The content-start audit has one immutable event
for the same content/version and deduplication window. A wrong exact TLS pin and
a corrupted RS256 signature are both rejected.

## Explicit limits

- TLS listens only on `127.0.0.1` with a short-lived self-signed certificate. Only
  this test's `HttpClientHandler` pins it; no global trust store is changed.
- The local adapter supplies the existing staging virtual host to the router
  factories and maps the synthetic Access token header to the assertion header.
  No DNS, production-origin pin, cloudflared binary or authentication policy is
  changed. The harness does not contact the actual staging hostname.
- Real RS256 validation runs in the normal recipient identity function. JWKS
  discovery uses a synthetic local key set, and the token helper is an in-process
  test runner. There is no real Cloudflare human sign-in or cached-token test.
- The Ops remote-reader service-binding proof remains an explicit synthetic
  fixture. Local D1 authority, file index, R2 bytes and content audit are real;
  this is not proof of deployed Ops/Client service-binding authorization.
- This is a Node adapter around actual route factories, not a deployed Worker
  ingress test. The two MiB response is deliberately drained after the socket
  drop, so R2 upstream cancellation is not claimed.
- No employee gateway/container, remote server filesystem, live R2, Engineering
  Hub runner, NAS, real client data, writable synchronization, Cloud Files
  registration, installer, signing or update publication is exercised.

Those remain separate acceptance requirements for the full Windows app goal.
