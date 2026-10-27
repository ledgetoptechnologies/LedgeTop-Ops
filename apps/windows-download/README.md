# LedgeTop Files Windows read-only pilot

This contains the .NET 10 transfer library, Windows settings/activity app,
system tray, branded Explorer connection and files-on-demand provider, with
human Cloudflare Access and separate portal and employee read adapters.
The unsigned per-user pilot installer is available in
`S:\LedgeTop Operations\Sync App`. Start with `LATEST-PREVIEW.txt` and
`CURRENT-STAGING-STATUS.txt`; versioned receipts retain their original build-time
observations. Code signing is intentionally off. Uploads and automatic catalog
refresh are not implemented. Shared 0.5.2 does not include automatic updates;
the unpublished resident-update work below is separate.

## Current verification — October 26, 2026

- Installer 0.5.2.0 completed on the desktop; all 524 payload files, registry,
  ownership marker and Start menu targets matched. Setup did not launch the app.
- Actual authenticated Company-file native acceptance passed ordinary open,
  content verification, keep, free-space cache removal without source calls,
  redownload and exact owned registration cleanup for two approved staging
  files, including the largest at 126,453,788 bytes. The largest-file run also
  released its final downloaded payload and verified its source hash and the
  inventory unchanged.
- Generated native acceptance also covers recursive keep/free, edited-file
  preservation and provider shutdown. These results are separate from laptop UI
  confirmation and do not establish acceptance of every real file.
- The server headroom fix is active and independently verified. The recovered
  gateway's source mount is read-only, with original roots/grants retained.
  Actual production catalog capture passed the exact 19-file approved inventory,
  one directory and 1,919,807,773 total bytes. This resolved real manifests without
  downloading every file body to Windows; it does not prove an atomic catalog
  revision or retention of every gateway snapshot.
- Current laptop testing confirmed the Company connection and all 19 photos,
  with real download-on-open. The laptop's standard keep/free context-menu
  actions are missing, and its Status column is blank or unavailable. This is
  an unresolved Shell-integration defect; native API tests do not qualify menus.
  The remaining tray close/quit/reconnect lifecycle still needs acceptance. Actual uninstall has
  not been tested; relocating the real uninstaller does not isolate its use of
  current-user profiles. The current gateway now uses `unless-stopped` and the
  retired gateway `no` restart; actual reboot/crash acceptance remains untested.

The current installed/shared Windows payload remains 0.5.2.0 from source
`e654af09379b3862a84563bed791868eb9caf77e`. The later backend-only commit
`1d85aa18e89d326f1222618a9163acb694aefa1c` does not constitute a new Windows
installer. Its maintainable change merged through PR #294 as
`75ca5453e1c511d4c295df9862397b8dafd4732e`; the separately qualified staging
runtime is `bba93046-3a9f-4df5-a987-3c35d9af9dab`. Shared current instructions now
mark the unchanged installer ready for laptop acceptance.

Working files appear in Explorer; the app contains connection controls and
activity. Closing Settings keeps a working tray connection running; Quit drains
the provider. Reconnect restores the saved inventory. Explicit Remove and a new
connection prepare a fresh inventory and logo generation, preserving old local
files. Shared 0.5.2 creates no startup task or Windows service.

### Unpublished resident-update source

The draft includes installed-payload verification, authenticated metadata and
download checks, graceful drain, an authenticated helper and fixed installed
relaunch. Scheduled checks run every six hours with an initial delay, skip busy
or disconnected sessions, and pause after uncertain helper outcomes. Settings
can disable automatic attempts. These preferences contain no account or token.

An optional Start with Windows control manages only the exact owned pilot HKCU
Run value. Forward setup preserves its source choice; uninstall removes only an
exact owned value. A checked interactive Finish option launches the installed
app after setup; silent updates never use that launch path. Neither startup nor
update reconnect opens a browser or substitutes another source/account.

Local synthetic schedule, startup, resume, cancellation and settings tests pass.
Twenty actual isolated NSIS registry cases passed against a new private test
key; this is not real startup/logon, interactive Finish or installed upgrade
acceptance. The backend feed remains default-off and no new installer is shared.
Actual connected replacement/relaunch/reconnect and Shell-menu repair remain
release gates. Automatic client/employee discovery is under backend contract
review; it is not a deployed endpoint or a reason to guess roles from email.

### Unpublished legacy Preview cleanup

The older portable `LedgeTop Files Preview` has a separate generated V2 ownership
receipt, so uninstalling shared 0.5.2 does not remove it. The draft's explicit
uninstall path now includes that exact recorded preview after checking ownership;
ordinary installation/startup does not migrate or start the demo. Uninstall keeps
local folders and all downloaded, modified and added files. It does not download
online-only files or promise that unhydrated placeholders become local copies.

The draft also accepts `--installer-remove-legacy-preview` in a packaged pilot to
remove only that recorded demo, without preparing/removing Company or Client
connections. Both applications must be quit first. This command is not present in
the shared installer yet. Missing/invalid receipts are refused for this dedicated
repair; do not delete registry entries or restart an unknown old demo to recreate
ownership. Normal uninstall handles known receipts only and cannot prove that an
untracked old entry is absent.

Retries verify the saved physical-root identity and exact native/Shell absence
without repeating unregister. A changed, missing or uncertain root is refused.
Compilation and injected lifecycle tests pass. A separate explicit generated-only
native acceptance registered and hydrated a fresh private preview, retained its
downloaded/modified/added files through one owned removal, then passed fresh and
repeated exact absence verification with an unchanged receipt. This does not
qualify the fixed legacy wrapper against an actual old installation or a real
uninstall; those remain release gates. Native acceptance is opt-in through
`--generated-removed-absence-acceptance`; normal tests never run it. Do not replay
an uncertain native run or use the default user profile as a test fixture.

The proposed NAS/R2 replacement is described in
[`nas-r2-bidirectional-sync-design.md`](../../docs/nas-r2-bidirectional-sync-design.md).
It is source-only; this pilot still has no upload or bidirectional engine.

The harness commands below use synthetic identities and handlers; they do not
install software or establish live-source acceptance. Core uses the SDK alone;
the Windows desktop and Explorer projects also require the exact Windows SDK
reference package described below.

The Explorer UI offers **Client deliveries** or **Company files** before sign-in.
The earlier transfer window remembers an offered choice per release channel. Switching stops and saves
the previous transfers before opening the other source; a denied sign-in never
falls back to the other mode. The preference grants no access. Each service
still checks its own current identity and grants.

The historical desktop checkpoint `3250e1ed` passed 38/38 synthetic App groups on
2026-10-23, including selection, switching, pause/resume and shutdown races.
That result does not qualify a live login, installed package or files on demand.
Run the desktop harness on Windows with the pinned SDK and local feed prepared
below:

```powershell
dotnet run --project AppTests/WindowsDownload.App.Tests.csproj -c Release -p:UseSharedCompilation=false -p:RestoreConfigFile="$sdkConfig"
```

## Run the synthetic acceptance harness

Use the reviewed .NET SDK `10.0.402`. From this directory:

```powershell
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
dotnet run --project Tests/WindowsDownload.Tests.csproj -c Release
```

`global.json` pins the SDK. Core and its console harness target `net10.0`;
the WPF app and its harness target `net10.0-windows`. `NuGet.Config` clears
external package sources. Core tests inject synthetic HTTP handlers; they do
not create a listener, use cookies, access R2, contact a server or read credentials.
They create isolated temporary folders and clean only their owned trees.
Windows reparse tests use unprivileged temporary directory junctions, without
changing developer mode or requesting elevation. Unix uses symbolic links.
Windows file-symlink creation is not tested on machines without that privilege.

For a fresh Windows checkout, bootstrap `Microsoft.Windows.SDK.NET.Ref`
`10.0.22621.57` into a new local feed. The script downloads only that official
NuGet package, verifies its pinned length/SHA256 and NuGet signature, and retains
the qualified SDK/CsWinRT licenses. It does not change global NuGet settings:

```powershell
$sdkFeed=Join-Path $env:TEMP ('ledgetop-sdk-'+[Guid]::NewGuid().ToString('N'))
../../scripts/windows-bootstrap-sdk-reference.ps1 -OutputDirectory $sdkFeed -DotnetPath (Get-Command dotnet).Source
$sdkConfig=Join-Path $sdkFeed 'NuGet.Config'
```

Use `-p:RestoreConfigFile="$sdkConfig"` on desktop, Explorer and retained live
acceptance builds. For offline reuse, pass `-SourcePackagePath` to the bootstrap
script with the already qualified package; the same hash and signature checks
still apply. The workflow starts with an isolated NuGet cache and uses this
explicit local feed; a previously populated user cache is not a prerequisite.
For self-contained notice verification, add `-IncludeRuntimePacks` to download
the three exact signed `10.0.13` Windows runtime packs requested by SDK restore.
Their lengths, hashes and bundled licenses are checked as well. An explicit
`-RuntimePackageDirectory` can reuse those public NuGet package files offline.
The WPF payload deploys the .NET Core and Windows Desktop runtimes; the ASP.NET
pack is a restore prerequisite and is not deployed by this app. These steps only
build files; they never execute or install the generated application.

The console prints its acceptance groups and returns nonzero on failure.
They cover interruption/resume, strict version/range checks, hash mismatch,
truncation and overflow bounds, cancellation, unsafe names/origins, redirects,
existing and late-created destinations, reparse paths, exclusive transfers,
state corruption, oversized-response retry and post-promotion cleanup failure.
Additional groups cover explicit sign-in versus cached-token lookup, pinned
executable integrity, origin confinement, bounded subprocess output, authenticated
discovery/folders/manifests, safe renewal and credentialless transfer state.

On Windows, run the separate desktop acceptance harness with:

```powershell
dotnet run --project AppTests/WindowsDownload.App.Tests.csproj -c Release -p:UseSharedCompilation=false -p:RestoreConfigFile="$sdkConfig"
```

For an interactive synthetic preview, explicitly build the developer variant:

```powershell
dotnet run --project App/WindowsDownload.App.csproj -c Release -p:LedgeTopDeveloperBuild=true -p:UseSharedCompilation=false -- --demo
```

The preview uses generated demo content, not client files. A plain Release build
does not opt into developer/demo behavior. Packaged builds use compiled trusted
profiles and ignore arguments and developer settings; this command is not a
client installer or live sign-in acceptance.

Offline installer-input and release-offer tests take explicit fixture paths;
they do not default to an operator's private release artifacts. The optional
`scripts/windows-release-test-fixture.ps1` helper accepts an explicit reviewed
commit, pinned public cloudflared binary, pinned NSIS compiler, SDK path and
locally built Core assembly. It creates a synthetic metadata assembly and an
Abort-only test PE in a new directory. It never executes either generated file
or cloudflared. Pass its returned directories to
`scripts/windows-app-release-offer.test.ps1`; these checks qualify validation
contracts, not a usable installer or a published release.

## Authenticated portal adapter

Company-file acceptance above does not qualify the current Client deliveries
path or its files-on-demand behavior. Each source needs its own current grants
and acceptance evidence.

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
The pilot bundles the reviewed, hash-pinned official cloudflared helper and its
license. Compiled release profiles select the application and helper pin;
current source-specific live acceptance remains separate from packaging.

`PortalClient` uses the existing native delivery discovery and folder routes.
Each portal metadata request has one 60-second linked cancellation deadline
covering cached-token lookup, response headers and every bounded response-body
read. `ResponseHeadersRead` alone does not bound body consumption. A deadline
failure stays a generic timeout; explicit caller cancellation remains cancellation.
Controlled synthetic streams test a valid header/prefix followed by a permanent
stall, upstream cancellation and response disposal, plus token/header stalls.
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
Employee server-folder access has a separate explicit read grant and private
Docker gateway. The current staging test covers only its approved Test Data
root; installation alone grants no access to other folders. Broader deployment
and Client deliveries qualification are separate from this test.

Employee ownership is independent: Ops manages Ops staff, and each PA manages
its own people. PA employee snapshots/entitlements cannot provision or change
Ops staff. Windows file reads require current native Ops admission plus an
explicit file grant; a PA account or matching email is insufficient. Client
profiles remain synchronized only to their selected PA destinations.

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

## Employee read adapter

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
Synthetic acceptance includes the owned test apphost subprocess and verified
downloader. Route factories require explicit server configuration and authority.
The approved staging root is activated separately; current single-file and
full-folder acceptance status is recorded above.

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
from the configured queue APIs. No JWT, cookie, expiring byte handle or download
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
// and the current authorized file list. Server activation and grants are separate.
using var source = new EmployeeQueuedDownloadSource("ltds-employee", session);
var selection = await source.GetReferenceAsync(rootId, path, cancellationToken);
await using var queue = await TransferQueue.OpenAsync(stateDirectory, source, cancellationToken);
var job = await queue.EnqueueAsync(selection.ResourceReference, destination, cancellationToken);
await queue.StartAsync(job, progress, cancellationToken);
await queue.WaitForIdleAsync(cancellationToken);
var jobs = await queue.GetJobsAsync(cancellationToken);
```

See [the source API contract](../../docs/windows-queue-source-bindings.md).
The separate portal successor implementation can retain logical identity across
reviewed publication updates only while every intermediate publication preserves
the original authorized mapping. Omission followed by restoration breaks that
continuity. See the source API contract for its bounded history and independent
current authorization checks; do not infer continuity from a matching path.
Queue persistence does not establish current authorization after restart.
The saved connection must still pass the current source/session checks; it
does not refresh its catalog automatically.

## Remaining product work

- Repair and verify the missing laptop Shell verbs/status, then complete real
  keep/free/reopen and tray lifecycle acceptance. Full approved-folder capture
  and laptop listing/download-on-open have passed. Current live expiry,
  identity-change and revocation scenarios still require
  their own evidence. Browser-profile copying, service tokens and bucket
  credentials are not client setup mechanisms.
- Version-fenced checksum coverage for existing and multipart files. Native
  selectors remain expiring person/grant-bound selectors, not bearer credentials
  or durable queue identifiers; the manifest supplies the separate stable ID.
- Server-controlled routing: employees read from an approved Docker/server
  gateway, while clients read only their authorized R2-backed portal content.
  Both adapters are implemented; current approved employee staging acceptance
  does not qualify unrelated roots or portal content.
- Current laptop UI/lifecycle and uninstall acceptance, broader large-media
  qualification, and publication/integration of the update channel. Signing is
  an optional future rollout decision; it is deliberately off for this pilot.
- Connected Explorer behavior for the complete approved catalog and laptop
  confirmation of branding, online-only opening, keep/free/reopen and restart.
  Cloud Files support is implemented and the bounded actual native test passed;
  those results do not substitute for these remaining acceptance checks.
- Writable employee synchronization, conflict handling and durable revisions.
  The separate Nextcloud pilot's preserved-mtime stale-overwrite failure is
  unresolved; this read-only foundation does not clear that writable gate.

Installing the package does not change a production service, TrueNAS stack,
public link or server access policy. Approved staging authority is provisioned
separately through the authenticated Operations administration API.
`CloudFilesNativeTransfer` provides the internal x64 transfer/progress boundary
used by the provider. See [native boundary limits and ABI evidence](../../docs/windows-cloud-files-native-transfer.md)
and the current verification scope above.
