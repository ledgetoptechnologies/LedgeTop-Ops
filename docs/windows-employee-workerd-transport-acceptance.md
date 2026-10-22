# Local employee transport through the full Ops Worker

This opt-in acceptance crosses the actual .NET EmployeeClient/Downloader, the
freshly bundled complete Ops staging Worker, emulated Ops D1 and the actual Python
`ReadServer` running in an owned local Docker container. The existing .NET and
Python fixture programs and the previous direct-router test remain unchanged.
The default fixture is the ordinary deterministic 2 MiB `map.bin`. Exactly
`LEDGETOP_EMPLOYEE_LARGE=1` opts into the existing fixed 3 GiB + 17 byte fixture;
other values are rejected and arbitrary sizes cannot be supplied. This larger
qualification exercises the new native FixedLengthStream framing and resumes
beyond a 32-bit offset.

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
the client TLS socket and drains the remaining owned response; end-to-end
upstream cancellation is a separate qualification.

Docker execution is permitted only after the context endpoint is a local named
pipe/Unix socket and the daemon reports Linux. Commands pin that checked context;
host/builder environment overrides are rejected. Plain `docker build` uses the
default Engine builder for that context and requires the Python base image already cached. This
follows [the documented context-bound default builder](https://docs.docker.com/build/builders/#default-builder). The generated resource names are
owned by this invocation. The gateway is unprivileged, read-only outside its owned
32 MiB tmpfs, with capabilities dropped, no-new-privileges, resource limits, no
host bind mounts and only IPv4-loopback published ingress. Large mode mounts only
a generated, labeled, verified plain-local Docker volume at `/synthetic`; no
driver options are allowed. Its ordinary Docker
bridge **has outbound capability**; this is not network-none isolation. The build
uses `--network=none` for RUN steps. The test does not read NAS paths or connect to
a remote Docker daemon. Container, owned volume, network, image and owned temporary output are
removed even on failure; final metadata checks refuse a passing leaked fixture.

Run explicitly from `apps/operations` with lockfile-matching dependencies:

```powershell
$env:LEDGETOP_TEST_DOTNET = 'C:/Users/fstor/.codex/cache/windows-download-dotnet-10.0.402/sdk/dotnet.exe'
node node_modules/vitest/vitest.mjs run --config vitest.employee-workerd-transport.config.ts
```

For the fixed large qualification, set `LEDGETOP_EMPLOYEE_LARGE=1` for that command.
Host free-space admission reserves four times the file size plus 2 GiB before
source/spool/destination allocation; the Python fixture separately checks its
owned volume capacity before streaming generation. Source creation, expected hash,
HTTP forwarding and .NET verification are streamed rather than buffering 3 GiB.
Interruption is at 2 GiB + 1 MiB + 17 bytes; both Node and .NET require the retained
resume offset to exceed Int32.MaxValue. Default timeouts remain unchanged; large
mode uses at most 480 readiness polls, caps the child at 480 seconds and the test
at 600 seconds. Product authorization, request and snapshot deadlines are unchanged.

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

Observed peak memory: .NET 56,025,088 bytes, Node host process 962,740,224 bytes (fixture/proxy setup; separate Workerd process
not measured), Python process 35,590,144 bytes. These are bounded local
observations, not published product performance limits. They do not establish
standalone Workerd memory usage or hosted Cloudflare memory-budget compliance. The request-signal
compatibility-flag companion is a separate dependency to qualify in the combined
candidate; this receipt does not claim a physical-disconnect cancellation test.

## Qualified large native-framing run (2026-10-22)

The explicit large mode passed **1/1**, 135.88 seconds test / 137.27 seconds total,
with product fix `55e2934a`, fixture `0c6bf07b` and request-signal compatibility
companion `3fffd0b8`. Full Ops TypeScript check passed. The actual 3,221,225,489-byte
file verified SHA-256
`276e3167c7710b73691bbe9a3c0d66605ff1b21852b0afde7cc54d9f651797e0`.
The actual retained/resumed offset was 2,148,532,241 bytes, exceeding Int32.MaxValue.
Native response lengths were 3,221,225,489 and 1,072,693,248; statuses remained
200/206/403/412/403. TLS pin and invalid-signature refusal, cross-user/path denial,
same-size preserved-mtime mutation, stale-version refusal and post-revocation
handle refusal all passed. Gateway calls after revocation were zero; content-start
audits two. Terminal success included owned Docker volume, container, network,
image reference and temporary-file cleanup verification.

Observed peaks were .NET process 75,812,864 bytes, Node host process 2,004,856,832
bytes and Python process 36,491,264 bytes. Node includes local fixture/proxy work;
the separately spawned Workerd process was not measured. These observations do
not qualify hosted Cloudflare memory limits or imply standalone Workerd usage.
Host available space before allocation was 773,621,649,408 bytes; the owned volume
reported 769,816,645,632 bytes before source generation and 766,595,289,088 after.
Allocated source blocks occupied 3,221,233,664 bytes. This is bounded synthetic
local acceptance, not a NAS, Engineering Hub or deployed-service performance claim.

Unknown volume-create acknowledgement is also covered by cleanup: after local
Docker validation, large mode always attempts removal and checks absence of its
generated volume name, even if create never returned success. A bounded fault
probe created an actual empty owned volume, injected a CLI acknowledgement error,
and confirmed the real harness cleanup attempted removal and the volume was
absent. The harness exited with the deliberately injected error, as intended;
no container or large-file data was allocated for that probe.

## Independent current-main integration check

Root independently ran the ordinary acceptance on combined source `2807ec2f`,
which includes main `77eb072a`, the reviewed Windows source, this composition,
the native framing repair, and the incoming request-signal opt-in. It passed
1/1 in 73.41 seconds including mandatory cleanup. The 2 MiB download resumed
from 16,384 bytes, verified its digest, retained native 200/206 lengths, and
passed the other-user/stale-version/revoked-handle checks. Gateway calls after
revocation were zero and content-start audits were two. Safe evidence is in
`docs/staging/windows-employee-workerd-2026-10-22.json`.

The same combined review also passed 138 focused framing/transport tests, five
joined D1 tests, both app type checks, 38 composition/bundle/preflight tests,
and the separate actual Client-to-Ops named-RPC download acceptance. These are
local source checks; they do not authorize or prove a live deployment. The
large source test was independently reviewed without duplicating the transfer;
its cleanup-only follow-up was separately exercised by the empty-volume fault.
