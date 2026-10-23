# Large local employee transport qualification

The opt-in employee transport test now supports one fixed large size:
**3,221,225,489 bytes (3 GiB + 17)**. The ordinary invocation still uses 2 MiB
and its original 16 KiB interruption. This changes test fixtures only; the
production downloader, gateway and authorization code are unchanged.

The large run transfers actual bytes through the .NET `EmployeeClient` and
`Downloader`, actual Ops routes and native D1 authority/audit, signed gateway TLS
transport, and the actual Python gateway's HTTP server. The first client response
is interrupted after **2,148,532,241 bytes**, so the real retained file and resumed
HTTP Range offset cross the signed 32-bit boundary. Final streamed verification
matches SHA-256
`276e3167c7710b73691bbe9a3c0d66605ff1b21852b0afde7cc54d9f651797e0`.
The existing cross-user, traversal, fresh-manifest/stale-ETag and real grant
revocation assertions also run. The companion JSON receipt records actual
statuses, audit count, elapsed time, allocated source bytes and process peaks.

## Run explicitly on a PC

Use the reviewed SDK from `apps/windows-download/global.json` and a local Linux
Docker engine. From the repository root:

```powershell
npm --prefix apps/client ci --ignore-scripts
npm --prefix apps/operations ci --ignore-scripts
$env:LEDGETOP_TEST_DOTNET='C:/path/to/reviewed/dotnet.exe'
$env:LEDGETOP_EMPLOYEE_LARGE='1'
Push-Location apps/operations
try {
  npx vitest run --config vitest.employee-transport.config.ts --reporter verbose
} finally {
  Pop-Location
  Remove-Item Env:\LEDGETOP_EMPLOYEE_LARGE
}
```

Optionally set `LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT` to a new caller-owned receipt
path. The test refuses to overwrite that file. Omit the large flag for the fast
2 MiB acceptance. Other nonempty flag values are rejected; arbitrary sizes are
not accepted.

## Resource and storage bounds

- Before large allocation, available PC disk must cover four file lengths plus
  2 GiB reserve: source, two retained immutable snapshots and desktop destination.
  The local Docker volume must separately have three file lengths plus 512 MiB
  reserve before source generation. There is no sparse-file shortcut: source
  generation writes and fsyncs every byte, with allocated blocks in the receipt.
- The source and snapshots use one uniquely named, labeled plain **local** Docker
  volume without driver options or host binds. The normal small mode keeps its
  existing 32 MiB tmpfs. Only owned synthetic paths are used. Container, volume,
  network, image tag and desktop temporary files are removed afterward.
- Python generates and hashes a roughly 1 MiB repeating block. Node independently
  hashes that pattern in bounded blocks. .NET hashes the final file through a
  file stream. No large `ReadAllBytes`, full-body buffer or giant fixture array
  is used. The Node incoming-stream adapter has an explicit byte-counted 64 KiB
  queue and socket writes honor backpressure; negative raw .NET reads use headers
  only. Small signed gateway envelopes remain buffered independently.
- The gateway container remains capped at 128 MiB RAM, one CPU and 64 processes,
  with a read-only image, unprivileged UID and no capabilities. The normal
  disposable bridge has outbound capability; published HTTP/TLS ingress remains
  loopback only. The test rejects remote Docker endpoints/overrides.
- The test case is capped at ten minutes and its .NET child at eight minutes.
  Product request, session, manifest and snapshot deadlines are unchanged.
  Reported .NET/Python peaks describe their processes; the larger Node peak also
  includes Vitest, full D1 migration fixtures and route adapters.

This establishes actual local large-byte and greater-than-2-GiB resume handling.
It does not establish 30 GiB qualification, deployed proxy limits, poor-network
behavior, upstream cancellation, human Cloudflare sign-in, staging/EH execution,
NAS access, live R2, Cloud Files, writable sync or signed installer publication.
The synthetic JWKS discovery/token helper and local TLS adapters retain the
limitations described in the ordinary employee transport acceptance.
