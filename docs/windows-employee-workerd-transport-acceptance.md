# Local employee transport through the full Ops Worker

This opt-in acceptance crosses the actual .NET EmployeeClient/Downloader, the
freshly bundled complete Ops staging Worker, emulated Ops D1 and the actual Python
`ReadServer` running in an owned local Docker container. The existing .NET and
Python fixture programs and the previous direct-router test remain unchanged.
Only the ordinary deterministic 2 MiB `map.bin` fixture is allowed; the large-file
environment switch is rejected rather than running another 3 GiB qualification.

The real staging composition keeps its fixed Ops origin, Access issuer/audience
and gateway-name admission checks. Synthetic Alice and Bob have independent Ops
staff admissions; only Alice receives a root read grant. A local JWKS response
supports actual RS256 verification in Workerd. No PA employee synchronization or
real staff identity is used.

The test gateway profile uses the admitted virtual name
`https://employee-gateway-staging.ledgetopdroneservices.com`. No DNS is changed.
The Workerd outbound boundary allows only the exact issuer JWKS GET and exact
virtual gateway `/v1/read` POST; every other destination fails. The gateway POST
is forwarded only to the captured owned `https://127.0.0.1:<port>/v1/read` listener
with its ephemeral certificate as an explicit request-local CA, normal hostname
verification and `rejectUnauthorized: true`. Human Access assertions cannot reach
the gateway. The signed protocol headers and body remain unchanged; HTTP Host is
adapted to the physical loopback ingress. The listener forwards to only the
captured loopback-only Docker port. No global trust store, system certificate,
DNS configuration, production origin or authentication policy changes.

The unchanged .NET child validates its exact ephemeral TLS certificate pin, roots,
directory and manifest, then resumes an interrupted TLS response and verifies
SHA-256 before file publication. It checks another admitted user cannot reuse the
handle, path traversal is refused, same-size/source-mtime-preserving mutation
changes the immutable snapshot digest, stale If-Match gets 412, and saved handles
fail after actual Ops D1 grant revocation. The harness requires download statuses
200/206/403/412/403, exactly five authorized gateway operations, two content-start
audits, and zero gateway calls after revocation. The deliberate interruption cuts
the client TLS socket and drains the remaining small owned response; end-to-end
upstream cancellation is a separate qualification.

Docker execution is permitted only after the context endpoint is a local named
pipe/Unix socket and the daemon reports Linux. Commands pin that checked context;
host/builder environment overrides are rejected. Plain `docker build` uses the
default Engine builder for that context and requires the Python base image already cached. This
follows [the documented context-bound default builder](https://docs.docker.com/build/builders/#default-builder). The generated resource names are
owned by this invocation. The gateway is unprivileged, read-only outside its owned
32 MiB tmpfs, with capabilities dropped, no-new-privileges, resource limits, no
host paths/mounts and only IPv4-loopback published ingress. Its ordinary Docker
bridge **has outbound capability**; this is not network-none isolation. The build
uses `--network=none` for RUN steps. The test does not read NAS paths or connect to
a remote Docker daemon. Container, network, image and owned temporary output are
removed even on failure; final metadata checks refuse a passing leaked fixture.

Run explicitly from `apps/operations` with lockfile-matching dependencies:

```powershell
$env:LEDGETOP_TEST_DOTNET = 'C:/Users/fstor/.codex/cache/windows-download-dotnet-10.0.402/sdk/dotnet.exe'
node node_modules/vitest/vitest.mjs run --config vitest.employee-workerd-transport.config.ts
```

`LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT` can name a new caller-owned receipt file.
Exclusive creation prevents replacement. It contains safe digest/length/status,
resource-bound and bundle evidence, no assertions, HMAC keys or download handles.
The receipt is prepared before cleanup; a receipt alone is not a green test result:
check the terminal test result, which also includes mandatory cleanup validation.

This closes a local direct-router-adapter gap. It does not establish human sign-in,
live Cloudflare routing/D1, protected Engineering Hub execution, staging server or
NAS qualification, desktop installation, or writable synchronization. No cloud
resources or production settings are changed.

## Product regression found by this boundary

The first full Workerd transfer reached the Python source and passed authorization,
but the strict .NET downloader refused it before saving partial bytes. Whitelisted
header capture showed Python content status 200 with `Content-Length: 2097152`,
no encoding and a strong ETag. The final Ops Worker returned status 200 and the
same strong ETag, but **no Content-Length**. Metadata responses retained lengths.
The inbound gateway seam preserved length: the product route performed its
mandatory source-length validation before returning that 200.

The product transport wraps the guarded source in an arbitrary `ReadableStream`.
[Workers ignores a manually supplied Content-Length for such bodies](https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header).
A native [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream)
can carry the enforced response length without buffering the whole file. The
narrow product fix is a separate reviewed prerequisite; this harness neither
synthesizes the missing header nor weakens the .NET length/hash checks. Successful
full and resumed response lengths are explicit regression assertions.

## Qualified ordinary run (2026-10-22)

With fixture `0c6bf07b` and native-framing fix `55e2934a`, this full transport
passed **1/1**, 82.49 seconds test / 83.76 seconds total. Full Ops TypeScript check
also passed. The 2,097,152-byte file verified SHA-256
`91d6f139837323de3829070b54945b770230a2fbfd270b370184b57305bfaf65`.
The interrupted prefix was 16,384 bytes; successful response lengths were
2,097,152 and 2,080,768. Statuses were 200/206/403/412/403, gateway calls after
revocation zero, content-start audits two. Terminal success includes mandatory
container/network/image/temp cleanup verification.

Observed peak memory: .NET 56,025,088 bytes, Node 962,740,224 bytes (including
Workerd/D1 fixture setup), Python 35,590,144 bytes. These are bounded local
observations, not published product performance limits. The request-signal
compatibility-flag companion is a separate dependency to qualify in the combined
candidate; this receipt does not claim a physical-disconnect cancellation test.
