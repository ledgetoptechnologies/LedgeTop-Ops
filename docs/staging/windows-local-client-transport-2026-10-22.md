# Local Windows client transport acceptance

This opt-in acceptance adds a real network boundary to the Windows prototype.
It uses the actual .NET `PortalClient` and `Downloader`, the existing Client
catalog and successor router factories, real local Miniflare D1/R2, and the
existing Client publication, recipient-grant, delivery-grant and mandatory
content-start audit consumers. The Ops side uses its actual directory writer,
workspace/folder reservations, publication dispatcher, recipient enrollment and
delivery issuer/dispatcher against a separate real local D1 database. It changes no product code or deployment settings.

The source base is PR #236 commit `2cc7dcdd`; test source is isolated on
`codex/windows-real-transport-20261022`; the follow-up real Ops reader adapter is
isolated on `codex/windows-client-real-ops-reader-20261022`. The neighboring JSON receipt records
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
ordinary Client unit-suite discovery. Cross-application transport files live in
`apps/client/integration`, outside ordinary Client ambient-Env type checking; the
opt-in Vitest harness transpiles the cross-app graph. Client and Ops type checks
run separately; this does not claim a unified static cross-app Env type check. `LEDGETOP_TRANSPORT_RECEIPT`, when supplied,
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

The harness then applies `delivery.revoke` through the real Ops issuer, without
dispatching the revoke to Client. It verifies the Client grant remains active. Reusing the previously valid manifest produces `404`, no additional
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
- The Ops remote-reader proof now comes from the actual Ops catalog/successor
  entrypoints, backed by the full local 224-migration Ops chain and actual
  command-created grant, home, publication and folder authority. Owner/admission
  and external PA acknowledgments remain explicitly synthetic seed data. In
  particular, `acknowledgeCreate` updates the PA directory outbox/mapping rows
  locally; no actual PA round trip is exercised. The
  binding adapter calls real functions in-process; it does not prove a deployed
  Cloudflare cross-worker service binding. No handcrafted successor proof DTO
  rescues an Ops denial. Only the selected test profile receives authority.
- This is a Node adapter around actual route factories, not a deployed Worker
  ingress test. The two MiB response is deliberately drained after the socket
  drop, so R2 upstream cancellation is not claimed.
- No employee gateway/container, remote server filesystem, live R2, Engineering
  Hub runner, NAS, real client data, writable synchronization, Cloud Files
  registration, installer, signing or update publication is exercised.

The local Ops fixture pins the complete LF-normalized 224-migration inventory
(names plus per-file SHA-256) to
`cc84e0c3216e591ad8d546a89708dfc3dcd5a608a4bf455fefad745ced5800a4`.
It applies the existing migration loader with triggers intact, through
`0224_windows_portal_publication_chain_index.sql`; no historical manifest or
frozen database receipt is rewritten. The Ops-only revoke leaves Client active,
and the receipt records the actual reader's denied reply plus zero later R2
reads. These are direct-function local RPC adapters, not a deployed binding.

The unexercised production, employee and Windows delivery items above remain
separate acceptance requirements for the full Windows app goal.
