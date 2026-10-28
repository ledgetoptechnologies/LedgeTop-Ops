# LedgeTop Files Windows read-only pilot

This contains the .NET 10 transfer library, Windows settings/activity app,
system tray, branded Explorer connection and files-on-demand provider, with
human Cloudflare Access and separate portal and employee read adapters.

The unsigned per-user pilot installer is available in
`S:\LedgeTop Operations\Sync App`. Start with `CURRENT-STAGING-STATUS.txt`;
versioned receipts preserve their original build-time observations. Code signing
is intentionally off. Local edits/additions do not upload. Automatic catalog
refresh, automatic account/source selection and NAS/R2 two-way sync are not
implemented. Scheduled update checks exist, but the update feed is off and
replacement through that feed is not accepted end to end.

## Current verification — October 28, 2026

- Shared candidate **0.5.10.0**, source `d4d2cabeeed418724a4077816d4f744a2c2d66d2`,
  passed Windows CI `40725723008`. Its 524 payload files and 288 source entries
  were independently verified. The installer SHA256 is
  `b4f9401c3ff3978ef10757013ed05ebd721f73037fd03b6f4f950ab4c04e016e`.
  Version 0.5.9 is retained in `Archive\0.5.9` for rollback.
- Company-file hydration removes four redundant session probes: synthetic HTTP
  tests verify three requests rather than seven for a cold download. Both file
  resolutions remain, including principal, expiry, current authority, version,
  length and SHA checks. Portal and unknown sources retain their session checks.
  Actual-adapter/lifetime/source-gate tests cover denial, account changes,
  cancellation and pause/epoch changes. Activity wraps complete timing lines.
- Isolated native tests of both 0.5.8 and the candidate source passed ordinary
  download, exact-byte verification, Keep, Free/cache cleanup, redownload, final
  payload release and exact owned native unregister for the approved
  57,788,851-byte photo. Both tests used fresh hidden native roots, the same
  existing human staging access and pinned helper; neither created a Shell
  sidebar entry nor changed the installed connection.
- That sequential one-photo comparison did **not** demonstrate a speedup.
  Baseline cold read/hash took 11.187 and 9.541 seconds; candidate took 11.715 and
  10.628 seconds. Warm local read/hash took 27 ms in both. Queue time was zero;
  retained authorization/resolution and download phases dominated. Download
  timing includes disk writes and downloader checks, not just network time.
  This is not a statistical benchmark, laptop test or Photos-rendering result.
- The last main-PC process observation found **0.5.10.0**, with all 524 payload
  files matching the published inventory. Executor registry reads still reported
  0.5.7 activation, while its Run command pointed to 0.5.10. The running app's own
  registry read remains unobserved; no activation repair was attempted.
  Desktop control timed out opening Settings and exposed no LedgeTop window.
  User screenshots show downloads and Keep succeeding in 0.5.8. Warning-free
  cache cleanup passed in the isolated executable test; installed UI acceptance
  remains distinct.
- The cache correction handles long application-owned paths at the native
  file-open boundary without changing Windows policy. Its emitted-executable
  regression reproduced five failures before the fix and passes all eight
  cases afterward. CI explicitly tests that host because the dotnet host had
  masked the defect.

## Remaining acceptance and scope

The shared 0.5.10 Windows candidate removes manual Pause/Resume from connected settings
and the tray, and resumes saved pauses after fresh same-account validation.
Startup defaults on after source selection and verified installation ownership;
explicit opt-outs and conflicting Run entries remain preserved. Interactive
setup offers graceful shutdown of a verified supporting app and waits for its
actual exit. Builds through 0.5.9 lack that protocol, so their first upgrade uses
tray Quit followed by Retry within the still-open installer. Silent setup keeps
its busy refusal. These changes have focused and integrated synthetic tests;
installed acceptance remains separate from those tests and SMB publication.

Commit `400c557f` adds reviewed, synthetic-tested unified sign-in source preparation:
an account-bound discovery coordinator, one sign-in window, and saved-profile
routing policy. Hosted Windows CI `40732633194` passed for that exact commit.
It is not wired into production startup or the published installer.
The server discovery contract, native bootstrap and cross-audience account binding
remain pending; the current installer still offers the client/company chooser.

Commit `cee9bec0` wires startup to reopen exactly one verified owned saved
connection without the chooser, retaining its prepared principal and performing
fresh cached reconnect. New or ambiguous connections still need discovery.
Its Windows CI `40735518515` passed.

Beau subsequently narrowed the first installed release to employees. Commit
`84c3d4a5` opens employee Settings directly, without the client/company chooser.
The installed backend factory and reserved startup/resume admission refuse
client routing, with an explicit client-unavailable notice. Existing client
profiles and local files are not probed or removed. Employee sign-in still uses
the existing authoritative staff admission, principal and file-grant checks;
admitted employees with an empty inventory remain connected. Five focused test
groups, an independent source review, a separate packaged Pilot build and Windows
CI `40759058157` passed. Unsigned 0.5.11 contains this source and passed independent
524-file installed verification. Its actual main-PC upgrade offered graceful
closure and opened directly to employee Settings. However, cached reconnect
subsequently paused during source-session checks, so connected acceptance is
incomplete and no new installed speed result is available. The SMB status labels
it a test candidate. The common signed discovery preparation remains inactive
for any later multi-role release.

Commit `9e8b7bb3` adds bounded connection action/phase/reason diagnostics, retaining
the original typed cached-session failure instead of converting it to Unknown.
It changes no requests, authorization checks, pause/drain policy or file delivery.
Focused tests, independent review and Windows CI `40765679148` passed. Unsigned
0.5.12 was installed on the main PC: the real graceful-stop prompt, checked Start
option at Finish, new process and all 524 installed payload files were verified.
The saved employee index is unchanged. Connected acceptance remains pending:
the computer-control tool refuses the new app window binding after upgrade, so
the newest bounded Activity support code has been requested from Beau. No new
photo-speed or successful reconnect claim follows from installation alone.

Commit `f82aa0d4` adds two tracked availability workers and two concurrent distinct
hydrations per process/cache root. Per-entry leases, conservative durable quota
reservations, both authority checks and full SHA verification remain. Windows CI
`40739881077` passed. The Release build passed 172 Core groups, five Explorer
groups, and actual Windows-native generated-data Keep/Free/reopen, local-edit
preservation, reconnect, drain and exact unregister checks.

One real staging comparison of the same approved 57.8 MB and 114.8 MB photos
completed recursive Keep in **23.077 seconds with 0.5.10 versus 20.496 seconds
with f82aa0d4** (11.18% shorter). Both variants passed full hashes before ordinary
reads, Free/cache removal, reopen and exact cleanup. Callback overlap was one
versus two; source-download/network overlap was not measured. Both used Release
DLLs in the same framework host, not the installed app or Photos. This single
baseline-first pair does not establish a general speedup. Cold rehydration of
the smaller photo still took 8.802 versus 8.161 seconds. These source successors
have not been published as a new installer; the shared download remains 0.5.10.

Commit `7afc01ea` adds bounded attribute-change hints to wake the frozen inventory
scan, retaining the two-second fallback, fixed manifest and two-worker limit.
Windows CI `40747907653` passed. A generated-data native comparison with two
workers in both variants measured first Downloading callback at 1,724 ms with
f82 versus 126 ms with 7afc, and batch completion at 1,873 versus 257 ms.
Both passed full pin/cache hashes before reads, Free/cache removal, drain and
exact unregister checks. These timings measure provider callbacks for generated
data; they do not establish real-photo transfer speed or Explorer rendering time.
This successor also remains unpublished.

Actual installed tray close/quit/reconnect, full uninstall and legacy sidebar
cleanup, logon startup, authenticated update replacement, and current laptop
acceptance remain to be completed or rechecked against the intended release.
The historical laptop LoginRequired failure is not independently resolved by a
successful test on the main PC. Current Client-deliveries behavior needs its own
approved account/source acceptance; Company tests do not qualify it.

The main PC's stale 0.5.7 activation metadata was corrected to its independently
verified 0.5.10 payload by a separate, narrowly scoped support action. It required
the exact approved installer, an uninstaller independently reconstructed from
those installer bytes, a normal Quit of the verified pipe peer, actual process
exit and singleton ownership. All three participating HKCU64 pointers read back
as 0.5.10, with a flushed completion journal. No connection, local file, source
permission or normal startup guard changed. This proves executor-visible HKCU64
reconciliation only; it does not establish the application's prior registry view
or qualify another version's installation/update behavior.

After actual 0.5.11 installation, the same pinned read-only probe observed correct
0.5.11 product/version/uninstall/Run values in the desktop context, but older
product pointers in the executor context. SID, session, bitness and native key
metadata matched; the mechanism remains unknown. These observations do not
justify another registry repair or establish that the app reads the executor's
view. In-app update acceptance must observe the actual desktop path.

The prior read-only Test Data access expired October 28 at 20:33:11 UTC. Beau
approved the same read-only folder through October 29 at 20:33:00 UTC. A supported
human-authenticated successor command was accepted and its exact scope, expiry
and 14 payload/actor/gateway predicates were verified. This does not establish
loaded gateway enrollment or successful data-plane access. No other folder or
upload permission was added.
Installation does not renew access. No grant expansion, backend activation or
NAS change accompanied publication of 0.5.10. Operations subsequently verified
the minimal public-JWKS resolver reuse on staging at October 28, 21:32 UTC:
active version `b1023692-2ef2-4004-9187-4cb8b9bb9b65`, module SHA256
`f5c51d80fdae674718144c45738469f1af5a936882f6fb3a4eca217f5a4db379`.
Runtime configuration, assets and the current same-folder grant witness were
preserved. The 870-second manifest headroom remains unchanged. Public signing
keys have a bounded 600-second cache and 30-second unknown-key cooldown;
JWT expiry and current identity/admission/grant checks still apply per request.
This is staging activation evidence, not a new Windows file-download speed result.

Before that activation, a one-attempt metadata diagnostic used the exact 0.5.12 Core and pinned
installed helper with the existing cached sign-in. Both current-session checks
matched the saved employee principal and valid expiry, with cumulative elapsed
times of 2,562 and 3,169 ms. No browser login, catalog, Resolve, content, registry
or native operation was performed. This executor-context result does not prove
that the installed Explorer session recovered.

Commit `bb6a8c4b` corrects a source-proven recovery dead end: the existing 60-second
timer may recheck only confirmed transient session failures on the same owned,
newly paused generation. Fresh account/expiry checks and the engine's own source
gate precede resume. Permanent denial, expired sign-in, malformed metadata,
manual pause and uncertain local/native ownership remain held. Read-only UI
observations and fenced engine events preserve failure holds across races.
Twenty coordinator cases, focused regressions and independent source review
passed. Installed acceptance of this successor remains pending.

The successor also keeps one bounded local connection-failure record at
`%LOCALAPPDATA%\LedgeTop\Files\pilot\connected-explorer-pilot-employee\latest-connection-failure.json`.
It contains only a validated support code, UTC time and app version, with a
fixed schema/owner marker and a 1 KB limit. Writing requires the existing owned
employee index lease and current index; unknown files and uncertain ownership
are preserved. Diagnostic IO is best effort and never determines authorization,
recovery or shutdown. The integrated source passed four focused groups and
21 coordinator cases; actual installed log capture remains pending.

## Earlier evidence

Earlier real Company native tests covered the largest approved photo
(126,453,788 bytes), while generated provider tests covered recursive Keep/Free,
edited-file preservation and shutdown. The user confirmed the installer Finish
option starts the app in 0.5.4. Main-PC 0.5.6 testing established a branded Company
root, 19 authorized photos, open/Keep/Free/reopen and oracle hashes for two photos.
These are version- and scope-specific observations, not substitutes for the
remaining release acceptance above. Consult historical receipts for older
0.5.2–0.5.5 installation, package-context and laptop diagnostics.

Files appear in Explorer; the app supplies connection controls and activity.
Closing Settings keeps the tray connection running; Quit drains the provider.
Reconnect restores the saved inventory. Explicit Remove and a new connection
prepare a fresh inventory/logo generation while preserving old local files.
An owned empty catalog offers an explicit sign-in/refresh action; nonempty
catalogs are not automatically replaced.

### Resident-update staging candidate

The draft includes installed-payload verification, authenticated metadata and
download checks, graceful drain, an authenticated helper and fixed installed
relaunch. Scheduled checks run every six hours with an initial delay, skip busy
or disconnected sessions, and pause after uncertain helper outcomes. Settings
can disable automatic attempts. These preferences contain no account or token.

The Start with Windows control manages only the exact owned pilot HKCU
Run value. Forward setup preserves its source choice; uninstall removes only an
exact owned value. A checked interactive Finish option launches the installed
app after setup; silent updates never use that launch path. Neither startup nor
update reconnect opens a browser or substitutes another source/account.

Local synthetic schedule, startup, resume, cancellation and settings tests pass.
Twenty actual isolated NSIS registry cases passed against a new private test
key; this is not real startup/logon, interactive Finish or installed upgrade
acceptance. The backend feed remains default-off. Candidate 0.5.4 has manual
Finish-launch acceptance; this does not qualify startup, lifecycle or update delivery.
Actual connected replacement/relaunch/reconnect and Shell-menu repair remain
release gates. Automatic client/employee discovery is under backend contract
review; it is not a deployed endpoint or a reason to guess roles from email.

### Legacy Preview cleanup candidate

The sidebar label alone does not identify the old demo: candidate 0.5.3 also uses
`LedgeTop Files Preview` for connected roots. Later draft source gives newly
created connected roots source-specific Company files / Client deliveries names
and records the exact label in connected profile schema 4. Existing schema-3
connections retain their legacy label; generated schema-2 previews are unchanged.
Other valid source aliases use the generic `LedgeTop Files` label, with existing
source authorization checks unchanged. Reconnect and removal verify the exact
recorded label as well as root/context/namespace ownership.

Older binaries and the shared v1 diagnostic do not understand schema 4. Do not
publish a schema-4 candidate without a compatible diagnostic and forward-only
upgrade instructions; do not downgrade it into an older binary. Shared 0.5.4
includes the compatible v2 diagnostic; the older installer and v1 diagnostic
remain unchanged. This naming change does not fix or
verify native Explorer menu visibility.

The older portable `LedgeTop Files Preview` has a separate generated V2 ownership
receipt, so uninstalling older 0.5.2 does not remove it. Candidate 0.5.3's explicit
uninstall path now includes that exact recorded preview after checking ownership;
ordinary installation/startup does not migrate or start the demo. Uninstall keeps
local folders and all downloaded, modified and added files. It does not download
online-only files or promise that unhydrated placeholders become local copies.

The draft also accepts `--installer-remove-legacy-preview` in a packaged pilot to
remove only that recorded demo, without preparing/removing Company or Client
connections. Both applications must be quit first. This command is present in
the 0.5.3 and 0.5.4 candidates. The optional shared cleanup ZIP checks exact
0.5.3 installed bytes and must not be used against 0.5.4. The 0.5.4 uninstaller
contains the owned cleanup path; actual laptop cleanup is not yet accepted.
Missing/invalid receipts are refused for this dedicated
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

- Recheck current laptop Shell verbs/status, keep/free/reopen and tray lifecycle
  against the intended release. Earlier user confirmations and failures refer
  to different builds and PCs. Full approved-folder capture has passed. Live expiry,
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
