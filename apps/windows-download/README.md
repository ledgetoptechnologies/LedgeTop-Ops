# Windows download foundation (prototype)

This is a BCL-only .NET 10 transfer library and synthetic console acceptance
harness with a human Cloudflare Access bridge and native portal read adapter.
It is **not a released Windows desktop application, installer or sync client**.
Tests use synthetic identities and handlers, install no software and make no
production connections. No NuGet packages are required.

## Run the synthetic acceptance harness

Use the reviewed .NET SDK `10.0.402`. From this directory:

```powershell
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
dotnet run --project Tests/WindowsDownload.Tests.csproj -c Release
```

`global.json` pins the SDK, both projects target `net10.0`, and `NuGet.Config`
clears external package sources. Tests inject synthetic HTTP handlers; they do
not create a listener, use cookies, access R2, contact a server or read credentials.
They create isolated temporary folders and clean only their owned trees.
Windows reparse tests use unprivileged temporary directory junctions, without
changing developer mode or requesting elevation. Unix uses symbolic links.
Windows file-symlink creation is not tested on machines without that privilege.

The console prints its acceptance groups and returns nonzero on failure.
They cover interruption/resume, strict version/range checks, hash mismatch,
truncation and overflow bounds, cancellation, unsafe names/origins, redirects,
existing and late-created destinations, reparse paths, exclusive transfers,
state corruption, oversized-response retry and post-promotion cleanup failure.
Additional groups cover explicit sign-in versus cached-token lookup, pinned
executable integrity, origin confinement, bounded subprocess output, authenticated
discovery/folders/manifests, safe renewal and credentialless transfer state.

## Authenticated portal adapter (not deployed or live-qualified)

`CloudflareAccessSession` runs an absolute, hash-pinned official cloudflared
binary directly, without a shell. Only `ExplicitLoginAsync` can launch its human
browser login. Cached-token lookup uses the same fixed protected application URL,
such as `https://portal.ledgetopdroneservices.com/portal`; the bare hostname is not
assumed to discover a path-scoped Access application. API requests carry the token
only to that exact HTTPS origin. Redirects, ambient cookies and default system
credentials are disabled. Authentication expiry and grant denial are distinct.

cloudflared owns its normal per-user token cache. The app neither inspects nor
copies that cache and stores no token itself. Local JWT decoding checks expiry
only; Cloudflare and the portal validate identity and current resource grants.
The token retains the person's portal authority. The adapter's GET-only interface
is a local restriction, not a new server-enforced download-only credential.
The bundled cloudflared version, official provenance, license and SHA-256 still
require a reviewed packaging decision and real staging login acceptance.

`PortalClient` uses the existing native delivery discovery and folder routes.
The accompanying server `download-manifest` route returns an opaque logical ID,
upload version, SHA-256, length, strong ETag, safe name and short-lived relative
download route after current human authorization. A fresh encrypted handle pins
the upload version and digest. Metadata and acquired bytes both check these pins,
including same-ETag replacements. Logical ID plus upload version identifies local
partial state, so renewing a handle cannot append a different upload version.

The server currently requires R2's stored full-file SHA-256. A missing checksum
returns `download-checksum-unavailable`; it does not trigger a large download in
a Worker or substitute an ETag. Older and multipart files still need a separate
version-fenced checksum backfill/ingest implementation before broad acceptance.
Employee server-folder access is also pending its own explicit read-grant and
Docker gateway implementation. Neither limitation is cleared by synthetic tests.

## Transfer contract

The authenticated portal adapter supplies `DownloadSpec`: an opaque logical
resource identity, a fresh HTTPS content URI, a safe output basename, exact
length, canonical strong ETag and trusted full-file SHA-256. The hash must come
from trusted server metadata. Calling the transfer library directly does not
establish authorization. An R2 ETag is not a substitute for SHA-256.

The production constructor uses an exact HTTPS origin allowlist and an
`HttpClientHandler` with automatic redirects, cookies, default credentials and
decompression disabled. GETs carry `If-Match`; resumed GETs additionally carry
`Range` and `If-Range`. Resume requires exactly `206`, the expected strong ETag,
remaining Content-Length and exact Content-Range. A `200` during resume, changed
version, redirect, content encoding or malformed range is refused. Reads are
bounded by the trusted remaining length plus one overflow-probe byte, with a
64 KiB buffer and a configurable maximum file size (1 TiB by default).

Partial files live below the chosen output directory in `.ltds-downloads-v1`.
The directory has an ownership marker; each descriptor has an exclusive lock,
partial file and small credentialless state record. State contains only a
hashed descriptor, version, length, ETag and SHA-256. It contains no content URL,
query string, authentication material or raw opaque resource identity. An
unowned state directory or mismatched descriptor is refused. Valid interrupted
prefixes resume by their actual file length. A rejected oversized response
removes its newly appended bytes. An unpromoted full-length partial is fetched
again because this prototype does not persist a completed-response receipt.

Only a complete matching SHA-256 is promoted, through a same-root no-overwrite
move. The verification handle denies writes through promotion on Windows.
Existing output files are never replaced, even if created after HTTP starts.
Promotion is the completion boundary: locked state metadata can remain for later
cleanup without incorrectly reporting that the verified final file failed.

## Employee read adapter (unmounted server draft)

`EmployeeClient` uses the human `CloudflareAccessSession` against one fixed Ops
HTTPS origin. It discovers at most 100 explicitly granted labeled roots, reads
UTF-8-sorted directory pages of at most 200 entries, and obtains a trusted
manifest for an exact relative source path. Paths and cursors are escaped once;
traversal, malformed metadata, duplicate fields, redirects, unsafe output names
and responses exceeding the bounded JSON limits fail closed. Discovery/list
requests have a 60-second deadline; manifest preparation allows up to 15 minutes
with explicit cancellation for the initial large-file copy.

The manifest requires a content SHA-256, matching content version and quoted
SHA ETag. Download state uses logical file identity plus SHA, so renewing a
snapshot handle can resume the same version while changed content starts a
separate transfer. HTTP 401 requires explicit human login, 403 denies access,
and 404/409 requires rediscovery or manifest renewal; none launches a browser.
Synthetic acceptance includes the actual owned test apphost subprocess and
the verified downloader. Public employee route factories remain unmounted;
live provisioning, staging sign-in and large-file acceptance are still gates.

## Filesystem boundary

The caller chooses an existing absolute local directory owned by the signed-in
user. Unsafe basenames, Windows device names, traversal, alternate data stream
syntax, UNC roots, symbolic links, junctions and reparse ancestors are refused.
Use a private local directory, not a shared writable folder or a folder managed
by another sync product. The BCL checks are not an OS sandbox against a hostile
local process replacing paths concurrently or forging owned metadata/hard links.
No promise of remote wiping or deletion of already-downloaded data is made.

Final hashes protect content integrity; they do not establish client identity,
current authorization or whether a future server adapter may issue a manifest.

## Durable queue core and source adapters

`TransferQueue` now persists an app-owned queue for one trusted source alias and
server-derived principal. `EmployeeQueuedDownloadSource` and
`PortalQueuedDownloadSource` obtain non-authorizing references and fresh manifests
from the unmounted queue APIs. No JWT, cookie, expiring byte handle or download
URL is stored in queue state. Keep the state directory private to the Windows
user; it must be an existing empty directory on first use. The UI can aggregate
multiple source queues without presenting a workspace switch.

Enqueue resolves current trusted pins. `StartAsync`/`RetryAsync` schedule one job;
`WaitForIdleAsync` awaits it, and `GetJobsAsync` returns its state after checking
the current session. Active pause/cancel signals work immediately, even while a
session request is blocked or the user has signed out. Inactive changes remain
session-gated. The start cancellation token governs admission; use pause/cancel
to stop a scheduled transfer. Progress distinguishes Receiving, Verifying and
Completed; receiving bytes are not yet integrity-verified. Completed is reported
only after hash validation and atomic promotion.

After restart, Running jobs become Paused. Every retry resolves current identity
and content pins before using existing partials. A changed content version blocks
the old job until explicit selection of a new version. If a crash occurred after
file promotion but before queue completion, exact interrupted-job recovery can
verify the existing local length/SHA and fresh identity without overwriting or
downloading it again. Missing/ambiguous owned state requires manual recovery;
the app does not guess which files to delete.

```csharp
// session, rootId/path and directories come from trusted app configuration
// and the current authorized file list. These APIs are not activated yet.
using var source = new EmployeeQueuedDownloadSource("ltds-employee", session);
var selection = await source.GetReferenceAsync(rootId, path, cancellationToken);
await using var queue = await TransferQueue.OpenAsync(stateDirectory, source, cancellationToken);
var job = await queue.EnqueueAsync(selection.ResourceReference, destination, cancellationToken);
await queue.StartAsync(job, progress, cancellationToken);
await queue.WaitForIdleAsync(cancellationToken);
var jobs = await queue.GetJobsAsync(cancellationToken);
```

See [the source API contract](../../docs/windows-queue-source-bindings.md).
Portal publication refresh currently invalidates a reference; safe producer-side
continuity is unfinished and must be implemented before promising automatic
restart across ordinary publication updates. Routes remain unmounted, and this
code has no installed desktop UI or live enrollment.

## Remaining product work

- Real staging human sign-in, expiry/identity-change and revocation acceptance;
  live queue/session acceptance and reviewed cloudflared distribution. No
  browser-profile copying, service tokens or bucket credentials belong here.
- Version-fenced checksum coverage for existing and multipart files. Native
  selectors remain expiring person/grant-bound selectors, not bearer credentials
  or durable queue identifiers; the manifest supplies the separate stable ID.
- Server-controlled routing: employees read from an approved Docker/server
  gateway, while clients read only their authorized R2-backed portal content.
  Both adapters are implemented and synthetically tested; employee route
  activation and live deployment acceptance remain pending.
- Claude-owned UI/UX, signed Windows packaging, distribution/update policy,
  installation/uninstallation checks and real large-media transfer acceptance.
- Windows Cloud Files API / Explorer placeholders, online-only hydration,
  explicit offline pinning, eviction, cache lifecycle and revocation behavior.
- Writable employee synchronization, conflict handling and durable revisions.
  The separate Nextcloud pilot's preserved-mtime stale-overwrite failure is
  unresolved; this read-only foundation does not clear that writable gate.

No production service, TrueNAS stack, public link or client access policy is
changed by this package.
