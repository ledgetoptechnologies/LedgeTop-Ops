# Local employee gateway transport acceptance

This opt-in test joins the actual .NET `EmployeeClient`/`Downloader`, the actual
Ops employee-read router, real local Ops D1 native admission/root authority,
and the actual Linux Python employee gateway. It makes no product-code change.
It extends the separate local Client transport acceptance; neither test is a
deployed staging or production qualification.

## Run

Docker must use a local named-pipe or Unix-socket Linux engine. The harness
rejects `DOCKER_HOST` overrides and remote SSH/TCP contexts before building or
running anything. Use the reviewed Windows .NET SDK from `global.json`
(`10.0.402`) and the Operations lockfile. From `apps/operations`:

```powershell
npm ci --ignore-scripts
# Only when the reviewed SDK is not already on PATH:
$env:LEDGETOP_TEST_DOTNET='C:/path/to/dotnet.exe'
npx vitest run --config vitest.employee-transport.config.ts --reporter verbose
```

The explicit config keeps Docker/listener/subprocess work out of ordinary unit
suite discovery. `LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT` can point to a new
caller-owned JSON receipt; existing files are never overwritten.

## Actual joined boundary

The test builds `Dockerfile.transport-test` from the current gateway source.
The fixture process creates a 2 MiB deterministic file inside its owned private
container tmpfs, enrolls that exact Linux root and starts the normal
`ReadServer`/`Gateway`. No host directory or volume is mounted. The image is
read-only, runs as UID 65532, drops all capabilities and has resource limits.

A uniquely named normal Docker bridge permits a host-loopback published HTTP
port. This bridge **has outbound capability**; it is not `--network=none` or an
internal network. Fixture code makes no external calls. The test binds both
published HTTP and its TLS adapter only to `127.0.0.1`. The container, its
network and its image tag are removed after the test. The ordinary production
Dockerfile and entrypoint do not include this fixture.

The .NET process talks to the actual Ops router over TLS. Ops signs its ordinary
HMAC protocol requests and sends them over a second actual TLS connection to
the local adapter, which forwards the exact body/headers to the Python HTTP
service. No endpoint response is invented. The adapter refuses unexpected
gateway destinations and asserts human Access headers never reach the gateway.
This is local reverse-proxy transport acceptance, not production ingress/TLS
configuration acceptance.

Full Ops migrations through `0223` run in temporary Miniflare D1. Native
profiles/admissions are explicitly seeded only for synthetic owner/Alice/Bob.
The normal provisioning service registers the enrolled root, grants Alice exact
root access, and later revokes that grant. Bob is admitted but has no file
grant. The normal identity resolver, RS256 validation, authority rechecks,
signed gateway transport and content-start audit all execute without mocks.
Only JWKS discovery and the cloudflared token-helper runner use synthetic local
fixtures. No real human session, credentials or interactive login is used.

## Acceptance assertions

- Actual root discovery, Python directory listing and manifest parsing succeed.
- The first download response sends exactly 16,384 bytes, then its client TLS
  socket is cut. The downloader keeps an uncommitted prefix, sends the actual
  `Range: bytes=16384-` request, receives `206` and verifies the 2 MiB SHA-256
  `91d6f139837323de3829070b54945b770230a2fbfd270b370184b57305bfaf65`.
- An admitted different user cannot reuse Alice's content handle (`403`). A
  traversal path is refused (`400`) before a gateway request.
- The test edits only its owned synthetic source file, preserving size and
  mtime. A fresh real manifest has a different digest; a stale `If-Match` sent
  against that new handle is rejected (`412`). Existing prepared snapshots keep
  their documented immutable semantics; this does not claim they must change
  when the live source changes.
- Real grant revocation makes the previously issued new handle fail (`403`)
  without another gateway call or published destination file.
- A mismatched exact TLS certificate pin is rejected. Each content-start attempt
  receives its normal durable D1 audit row; the full and range requests produce
  two rows.

The fixture drains its owned gateway response after deliberately dropping the
client socket. Gateway upstream cancellation/backpressure under deployed load
is a separate qualification. The local acceptance does not exercise NAS mounts,
staging 50.90, live Engineering Hub, real Cloudflare sign-in, live R2, writable
sync, Windows Cloud Files registration, signed installation or update publishing.
Those remain requirements of the full Windows app goal.
