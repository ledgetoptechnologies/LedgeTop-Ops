# Installed Windows application and Operations-managed updates

## Current owner direction — October 28, 2026

Beau created an Azure Artifact Signing account and requests signing again. The
earlier unsigned-only decision below is historical. Portal observation confirmed
the Basic signing account in East US. At Beau's explicit request, his Azure user
was assigned Artifact Signing Identity Verifier on that signing resource only;
Azure returned a success notification. Beau completed the organization form, and
the portal subsequently showed Public validation for Ledge Top Technologies LLC
as **In Progress**. No business identifier was copied into these records. The
relationship between the requested publisher name and the business identifier's
existing name remains an owner question; approval must not be presumed. Public
Trust certificate profile, signer permission, CI federation and actual signing
remain unqualified. No purchase, signing secret or certificate trust change was
made by this work.

The next release must be tested through the installed app's update action,
including authenticated offer/download, byte and publisher verification, safe
provider drain, actual old-process exit, installation and reconnect. Source-level
tests and a manually run installer do not qualify that sequence. The current
shared 0.5.12 is an unsigned diagnostic candidate with incomplete connected
acceptance; prior versions are archived. Its main-PC install and launch passed,
which does not qualify the in-app update sequence. The Operations update feed
remains off. GitHub holds source
and CI evidence, rather than serving as an enabled update channel.
The existing EXE consumer verifies authenticated release bytes but does not
perform Authenticode publisher verification. The current offline offer builder
refuses signed installers. Both require actual signed-release support before the
future publisher-enforced path can be qualified; signing a setup file alone does
not complete this integration. The current unsigned installed version can only
bootstrap using its existing authenticated hash/ETag policy. A subsequent signed
version-to-version update must prove publisher enforcement as well as lifecycle.

Beau also narrowed the first Windows release to employees. It should have one
employee sign-in entry and clearly explain that client access is not available
yet. Existing Client Portal services and saved client data are not removed by
this Windows capability choice. Authoritative employee admission and folder
grants remain mandatory; zero currently shared folders do not disqualify an
otherwise admitted employee. The proposed Docker/Nginx server connection and
`ledgetop.app` hostname still require exact deployment/provisioning agreement.
This direction does not activate a hostname, expand access or implement NAS/R2
two-way synchronization. Current implementation and acceptance evidence is in
[the Windows README](../apps/windows-download/README.md).

## Earlier checkpoints

Beau requested a fully installed Windows app and scheduled automatic upgrades on
October 25, 2026. The confirmed legal business name is **Ledge Top Technologies
LLC**. No Azure account/subscription currently exists, and no purchase, account,
identity submission, signing resource or trust-store change has been made.

Beau subsequently explicitly chose to leave release signing off for now and
accept Windows warnings. Do not set up Azure, buy a certificate, sign the app or
change local certificate trust for this phase. The active installer direction is
therefore a conventional unsigned per-user EXE installer, with installed shortcut
and uninstall entry. Normal MSIX installation requires a trusted signature, so
the MSIX construction and App Installer work below remain inactive research, not
the currently chosen delivery path. The portable ZIP remains a test build, not
installation acceptance. NSIS/free tooling and a separate authenticated Operations
update handoff need qualification; no compiler purchase or automatic update is
authorized by the signing decision alone. User already requested implementing
installation and Operations-controlled updates earlier in this chat.

## Concrete progress

The active unsigned route now has an NSIS 3.13 template and exact-commit payload
builder. Per-user versioned app directories, current-user Start Menu/uninstall
registration, explicit-file removal and no automatic app launch are implemented.
A temporary full payload runs read-only maintenance before any permanent version
directory is created, so a running-app refusal can be retried after normal Quit.
The maintenance protocol is compiled into the pilot app; older portable v4 bytes
cannot be repackaged as a working installer by changing a receipt. New normal
pilot launches observe the setup mutex before provider/backend work; maintenance
children bypass that gate. Old portable copies lack this gate and must be quit.

Maintenance checks only fixed pilot source ownership, without creating a backend
or browser session. Uninstall uses the existing offline owned-removal path and
requires confirmed Removed state before deleting exact app payload files. Missing
indices never authorize adopting/unregistering roots; matching untracked root
paths require the exact native not-under-sync-root HRESULT. User data, profiles,
cache, branding and old version payloads are retained. Unknown ownership refuses.
The real desktop check returned running-copy code10 with ownership JSON hashes,
lengths and write times unchanged; no removal command was executed.

App tests passed 60/60 groups, followed by targeted maintenance checks after the
native absence and startup-gate refinements. The NSIS isolated helper executable
passed eight path scenarios, including leaf/ancestor/nested junction refusal and
unchanged alias-destination content, and 18 version cases per run. Thirteen static
template tests passed. This is not full installer/uninstaller acceptance. See
`apps/windows-download/Packaging/UnsignedInstaller.md` for the actual contract and
remaining installed, upgrade, locked-file and cleanup checks.

Unsigned pilot **0.5.0.0** was built from source
`e20b9e789a7265e9a2dbbbea588eca289141f76f` with the pinned compiler and published
privately at `S:/LedgeTop Operations/LedgeTop-Files-Pilot-0.5.0.0-unsigned-setup.exe`.
It is 88,526,467 bytes, SHA-256
`dd4ee93b603ab500f263a7e559cf487273ddb9d68c58db159ed6a0588d1d1d71`.
The shared copy and four versioned companion files matched their local hashes;
LATEST-PREVIEW.txt was atomically updated and read back. Actual Authenticode status
was NotSigned as requested. No signing/trust purchase or automatic updater exists.

The exact-template isolated full installer test passed seven phases using a
synthetic maintenance stub and GUID-scoped paths/key/shortcuts: running refusal
and retry, installation, newer upgrade retaining old payload, old-uninstaller
refusal, cleanup refusal, nested-junction protection and exact-file uninstall.
Unknown residual files and local notes/profile fixtures survived. Receipt:
`C:/Users/fstor/.codex/tmp/windows-installer-isolated-qa-dfc11aa43dcd4cc88077ecfd1591bd55/receipt.json`.
This is not actual product/native connection acceptance. Builder input validation
passed 49 refusal cases and its positive case, including strict JSON field types.

The real 88MB product installer ran silently with desktop v4 active and returned
code10. No permanent version directory, Start Menu directory or uninstall key was
created; the old PID/start time and ownership metadata hashes/lengths/write times
were unchanged. The exact receipt is under
`C:/Users/fstor/.codex/artifacts/ltfiles-unsigned-installer-v5-20261025/real-running-refusal-receipt.json`.
Actual product installation/uninstall, clean-device and connected byte acceptance
remain open; the desktop owner was asked to quit normally before an actual install.

Subsequent real desktop diagnosis placed 0.5.0.0 testing on hold: Beau used tray
Quit, but the v4 UI thread remained in Windows ShellExecuteExW called by Open files
folder. Managed method-stack capture (no heap/locals) identified this directly;
repeating Quit cannot guarantee progress while that native call blocks. The fix
routes folder opening to one background STA worker, coalesces repeated clicks,
posts safe failures only to a live window, and never waits for that worker during
Quit. Injected blocked-shell WPF tests confirm the dispatcher/provider drain stay
responsive; a separate child exited naturally in 76ms while its fake Shell action
remained blocked for ten seconds. No real Shell call or forced process termination
was performed by those tests. A corrected 0.5.1.0 installer will supersede the
retained 0.5.0.0 artifact after verification; the shared latest pointer is on hold.

Beau requested ongoing PC cleanliness. Four old expanded download folders and
two local ZIP duplicates were verified against shared ZIPs/payload manifests and
moved under `.codex/tmp/LedgeTop-Files-2026-10-25/retained-downloads`. Twenty inactive
test/build work folders and 31 completed artifact folders were also consolidated
under the task's hidden `.codex` directories, with verified evidence archives and
old-to-new manifests. These were reversible moves: zero bytes were deleted or
freed. Automatic approval review rejected recursive deletion as “blocked by
policy”; no alternate deletion mechanism was used. The live v4 Downloads folder,
actual profiles/roots, toolchain caches, source worktree and shared downloads were
left intact. Future builds use those task work directories rather than Downloads.

## Current acceptance audit

Read-only observation of the actual desktop Employee connection found schema3
Ready, with zero files and zero directories in its frozen manifest. This is a
local snapshot observation, not a request to the server or proof the current
server has no files. Native and Shell readbacks matched the persisted root file
ID, context, provider policies, namespace and HKLM/HKCU records. All three ownership
JSON files kept their hashes and write times, and the old process kept its start
time. Receipt:
`C:/Users/fstor/.codex/artifacts/LedgeTop-Files-2026-10-25/owned-registration-observation/run-794dbe74396f4f088d7c38ad1f97d8c5/receipt.json`.

The actual saved entry still uses the legacy `shell32.dll,3` folder icon. This is
consistent with the preserved old receipt; it does not prove the current entry
has already acquired LT branding. New generations have native API proof for the
approved icon. Explicit Remove/reconnect is required for this legacy entry and
keeps the old folder's local files.

| Requested behavior | Authoritative evidence | Remaining acceptance |
| --- | --- | --- |
| Tray and graceful lifecycle | Native tray tests, 61 App groups, blocked-shell process exit test | Actual corrected app launch/Quit after old v4 exits |
| Branded Explorer entry | Approved asset hash and new-root native registration/readback | Current legacy entry needs explicit new generation |
| Open, keep, free and reopen | Native synthetic phases; Beau's complete v2 sequence | Actual authorized staging sample; saved desktop inventory has no entries |
| Settings and cached reconnect | WPF/action tests; v3 Company sign-in reported successful | Corrected installed app and saved-root reconnection on device |
| Private downloadable build | Shared 0.5.1.0 installer hash/length and companions verified | Actual installation, uninstall and clean-device acceptance |
| Operations-controlled updates | 140 Core groups, 37 producer cases, exact-byte offline interoperability | Owner agreement/producer, app wiring, parent-exit/install/relaunch and schedule |
| PC cleanliness | Verified evidence archives and 56 inactive-folder reversible consolidations | Old live folder remains; deletion was review-blocked, zero space freed |

Completion remains unproven. Immediate dependencies are Beau's one-time Task
Manager End task for the stuck desktop copy, an explicitly approved staging sample
followed by fresh inventory capture, and the Operations release owner's endpoint
and authority decisions. No previously revoked grant is re-enabled by this audit.

Historical MSIX research used Explorer source bc7723382124798c7b6ec92b4b2d5b7330e1adc7,
was packed with pinned Microsoft MakeAppx validation enabled. Unpacking matched
all 528 inventory files exactly. The unsigned construction MSIX is
`C:/Users/fstor/AppData/Local/LedgeTopFilesPackagePreviews/033f284a6394429e8a746e48fde90d23/preview.msix`,
90,741,516 bytes, SHA256
`6cbe7ef48d660cc962a3b5b8d51e84cb7845b61dda324748c96fbb2fcd942b20`.
The descriptor construction suite passed its positive case and 20 refusal cases.
This artifact retains the temporary Build Preview identity, is not signed, and
must not be offered as a trusted installable release.

The packaging script now composes Explorer SDK and runtime notices and uses
notice/channel helpers from the exact source archive. Helper vendor signature,
hashes and module/runtime notice inputs were verified. Complete third-party
attribution remains a separate release gate.

`scripts/windows-update-policy.mjs` provides an offline contract for an Operations
release implementation: approved configured channels, immutable four-part Windows
versions, package identity, exact verified certificate subject, fixed HTTPS feed
and artifact origins, size/SHA/source commit and matching actual signature/build
observations. It additionally binds the inner application's observed compiled
channel and rejects developer builds. Stable can remain unconfigured. Tests pass
48/48, including cross-channel/identity/signature/hash/version mismatches and
forward-version rollback. These functions do not verify signatures, authorize a
promotion, serve HTTP or install anything; callers must supply independent actual
verification and authorization. Synthetic JSON booleans are not that evidence.

## Update ownership and delivery

The current unsigned EXE path needs a native release producer, distinct from the
historical MSIX/App Installer proposal below. Read-only inspection of the other
frontend worktree found a flat Get the app DTO for `/api/app/latest?platform=windows`
and `/api/client/app/latest?platform=windows`; its mock/UI contract does not prove
that either server route exists. PA-Ops Integration is active and owns that area.
This Windows branch does not edit its frontend/backend or change Access policies.

The new Windows check/stage client is implemented against a **proposed
native extension**, not a claim of live compatibility. The producer must return
strict UTF-8 JSON with `schemaVersion: 1` and an `available` boolean. An available
Windows offer needs these flat fields in addition to the existing web DTO:

| Field | Native contract |
| --- | --- |
| `platform`, `channel` | `windows` and the client's explicit compiled channel |
| `version` | Canonical four-component unsigned-16 Windows version; newer only |
| `sizeBytes`, `sha256` | Positive bounded installer length and lowercase SHA-256 |
| `strongETag` | Actual immutable bytes' canonical strong ETag, echoed on downloads |
| `sourceCommit`, `installerType` | 40-hex source identifier and `exe` |
| `downloadUrl` | Same-origin relative path under that site's `/download/` route; no redirects or arbitrary query |

The web DTO can ignore these additional fields, but current web test fixtures
without them are not native-update acceptance. No artifact URL, channel or origin
comes from a settings file or command-line override. A configured client reuses
cached human Access authorization and never starts browser login. Pinning spans
fresh metadata and byte staging; credential changes, 401/403, malformed metadata,
unknown statuses and redirects must stop the operation rather than report that
the application is current. Stage results are verified bytes only, never an
installer launch, installed-version claim or promotion approval.

The backend owner must explicitly verify Access audiences/path coverage for the
release routes, check channel eligibility on each metadata/artifact request,
enforce scheduled rollout before offering a version, and bind the immutable R2
object to actual build-receipt/payload observations. A JSON boolean is not proof
of that verification. Ranged responses must preserve ETag/length and exact byte
semantics expected by the existing Downloader; authenticated redirects and HTML
login bodies cannot substitute. No file grant, client-record access or bucket key
is introduced. Code-signing remains off by Beau's choice; authenticated release
metadata and matching bytes still govern any future executable handoff.

`WindowsAppReleaseClient` passed nine synthetic test groups, and the integrated
Core suite passed 140/140 groups. The offline
`scripts/windows-app-release-offer.ps1` producer passed 37 actual-byte/refusal
cases, verifies the supplied immutable build evidence and actual PE metadata, and
writes exclusive candidate JSON/sidecar files. It checks actual installer length
and hash plus managed/installer version, pilot/protocol markers, source/template
and guard-script pins. Its sidecar explicitly does not independently prove the
NSIS inner payload, approve promotion, establish a server ETag or publish a route.

An offline producer-to-consumer run staged and rehashed the actual 88,527,444-byte
0.5.1.0 installer through a fake HTTP handler, then reused it after a second fresh
metadata check with no second content transfer. SHA-256 matched
`9f45eebc5a2e09dd37acafc221714116a1b8e4bbc83931c819063720e90e3330`.
Synthetic cached-token runners were used; no real helper, HTTP or execution.
The candidate JSON is at
`C:/Users/fstor/.codex/artifacts/LedgeTop-Files-2026-10-25/release-offer/operations-0.5.1.0-proposed.json`;
consumer verification is under the adjacent `release-client` directory.

Staging publishes a complete ownership marker into its private subdirectory,
refuses foreign markers and aliases, and never overwrites a changed existing
artifact. Cache reuse requires a fresh authorized offer and exact length/hash;
credentials are checked again under the held pin before returning bytes for any
future handoff. Metadata uses an absolute deadline; cached helper reads retain
their one-minute bound; downloads use inactivity limits and caller cancellation.
These filesystem observations are point-in-time. An eventual installer helper
must reverify scope/bytes and current authority at its execution boundary.

The client is not wired into the app or a schedule, and none of these routes has
been contacted. Endpoint agreement, actual producer implementation, graceful
parent-exit/installer/relaunch handoff and real device acceptance remain gates.
Existing MSIX check/stage code remains disabled and does not implement EXE updates.

Beau explicitly authorized coordination with the PA-Ops Integration chat. The
tested contract, current installer receipt and producer/consumer evidence were
sent there for ownership, route, Access audience, rollout and artifact-semantics
review. The first bounded status check still showed its existing active
Client-to-Ops work; no update-endpoint agreement or deployment is inferred.

Operations should own approval of the version offered on each release channel.
Published packages are immutable; moving a channel forward changes the approved
descriptor/version pointer, not an existing version's bytes. Pilot and stable
have distinct durable package identities and feeds. Rollback uses a newer signed
version carrying the last known-good behavior, with compatible saved-state
schema; do not broadly permit arbitrary downgrade.

The inactive MSIX proposal used Windows App Installer's silent, nonblocking
on-launch checks with a 12-hour interval and Windows-managed background checks
approximately every eight hours. That mechanism does not implement the current
unsigned EXE route. Its schedule and executable handoff remain unconfigured;
Operations rollout policy and device/network behavior need separate acceptance.

The other frontend worktree contains the proposed authenticated Get the app
contracts at `/api/app/latest` and `/api/app/download/…` (client equivalent under
`/api/client/app`). A DTO/dialog is not a functioning release backend. Native
background App Installer must not be assumed to inherit browser cookies or the
file client's cloudflared session. The backend owner must explicitly approve an
updater-accessible signed-artifact/feed endpoint, or choose a separately qualified
authenticated deployment path. No Access bypass, DNS change or hosting route has
been created implicitly. File-data authentication and grants remain separate
from distributing executable releases.

## Running-provider and installation acceptance

An installed tray application can remain open indefinitely. Descriptor settings
alone do not prove that an update can activate safely. Before replacement, stop
new hydration, cancel/drain existing work, persist state, disconnect the provider
and exit; defer if shutdown cannot be confirmed. Reuse the existing graceful
session disposal. The new internal `InstalledUpdateCoordinator` serializes update
admission, deferred staging, provider drain and restart handoff. Only Available or
Required may stage; staging failure leaves the provider running; failed drain
prevents restart. Cancellation after drain begins observes its completion and
postpones restart. Completed staging is retained across drain/restart retries.
Restart acceptance never claims the new version is running. This is tested with
fake deployment/drain/restart adapters and is deliberately not wired into the
portable app. Do not force-kill an active provider or unregister its root as part
of a normal upgrade. Cached reconnect must never trigger browser sign-in by
itself or restore revoked access.

`WindowsInstalledUpdatePlatform` supplies the Windows deployment side, using an
explicit approved compiled identity with no default feed or publisher. Before
every check/stage it validates the current installed package, exact publisher,
x64 architecture, nondevelopment status and exact App Installer association. It
reacquires its own package through PackageManager before checking availability,
and gates App Installer URI deployment on Windows build 22621 or newer. Staging
sets only DeferRegistrationWhenPackagesAreInUse; no force or unsigned flags.
Unconfigured checks return NotConfigured without OS deployment/network calls.
21 pure validation checks and an App compilation passed; configured deployment
has not been invoked. Canceled or failed staging does not prove Windows rolled
back a request already accepted. A supported restart adapter and signed-device
qualification remain required before enabling this path.

Verify trusted N→N+1 installation/update on a clean Windows 11 x64 machine,
including active transfers, offline/reboot, changed authority, wrong signatures,
tampering, channel separation, retained local edits and uninstall cleanup. Test
MSIX filesystem/state virtualization and uninstall behavior against the actual
owned root/profile locations rather than assuming portable behavior carries over.

## Signing setup still required

Microsoft Artifact Signing Basic is a proposed planning direction, not a required
dependency of direct download or Microsoft Store distribution. Azure is not
required to distribute an executable installer; another trusted signing provider
can be selected, and internal testing can use separately managed test trust.
The application, file storage and Operations updates need not be hosted in Azure.
Free test signing can use a self-signed certificate with deliberate per-device
trust; it is not a publicly trusted business identity and is not enabled here.
SignPath Foundation offers free qualifying open-source signing, but its terms
exclude proprietary components and its certificate names the Foundation as the
publisher. This has not been established as eligible for the private business app.
Other paid providers include SSL.com, Certum and DigiCert. SSL.com's October25
order page lists $129 for a one-year certificate, with signing-service/token
costs separate; that headline is not an all-in signing quote. No provider has
been purchased or selected by the user's questions.
On October 25, Microsoft's documentation lists US$9.99/account/month including 5,000
signatures, with paid Azure subscription required; free/trial/sponsored
subscriptions are explicitly unsupported for this service. Account creation can
be free while the chosen signing service is paid. No payment approval is inferred
from a pricing question. Budget, paid subscription setup, owner-led organization
validation, protected CI federation and profile-scoped signing rights remain to
be completed. The final manifest Publisher must come from the validated signing
certificate subject; the supplied legal name is not permission to invent a DN.

Sources reviewed:

- [Microsoft update settings](https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings)
- [Artifact Signing subscription requirements](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Artifact Signing pricing](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)
- [Artifact Signing setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [SignPath Foundation conditions](https://signpath.org/terms.html)
- [SSL.com certificate order](https://secure.ssl.com/certificates/code-signing/buy)
