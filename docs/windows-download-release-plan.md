# Windows files app: installer and release plan

Decision record, 2026-10-22. This is a release plan, not a published installer.
The existing .NET transfer core and human portal adapter remain reusable by
Claude's desktop UI. Do not make a signing purchase, publish binaries or register
a provider on a real user's folders as part of this source-only phase.

## Distribution decision

### Ownership and address checkpoint, 2026-10-22

Ops and each PA manage employees independently; only client profiles synchronize
to selected PA destinations. The Windows gateway/read/queue routes must continue
to require current native Ops admission and an explicit file grant, including
when a legacy staff row remains active or PA sends a grant for the same email.
The updated backend draft removes PA staff writers and PA-driven Access-group
rewriting without deleting existing staff or widening membership. The replacement
Ops-owned lifecycle and reconciliation control require their own reviewed
handoff, native admission and current-cohort checks before activation.

`ledgetop.app` and `portal.ledgetop.app` are separate migration candidates, not
active Windows endpoint replacements. Keep the currently reviewed fixed Ops,
portal and gateway origins until exact host, audience, CSRF, redirect and native
delivery acceptance is complete. Never teach the desktop to follow a redirect
with its human token to accommodate the domain move.

The backend draft includes the reviewed main/ready-PR CI policy and matches it
in the Windows/gateway workflows. This does not enable Engineering Hub execution
or satisfy required hosted checks. The corresponding CI policy release remains
separate from employee/client delivery activation.

### Installer target

Use a per-user, signed MSIX desktop package as the first distribution candidate.
The owner has made the source repository public for CI. Source visibility does
not provision file access or authorize binary publication. Publish signed binary
artifacts through a dedicated HTTPS download endpoint after release approval. A
GitHub source login must not be needed to install or update the app. Use separate pilot
and stable identities/channels so a staging app cannot replace production state.

MSIX supports desktop applications; it does not require converting the transfer
engine into a UWP application. Evaluate the UI packaging on a clean Windows 11
VM before committing to MSIX. If endpoint policy prevents MSIX, retain an MSI
fallback with the same signed publisher and data-protection rules. Neither
installer should require SMB credentials, bucket keys or a machine-wide service.
[Microsoft desktop packaging model](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)

### Signing route selected for planning, 2026-10-23

Beau delegated provider selection and answered the protected EH planning
decision `09ba712d-1085-4812-887b-929691ba3534`. Plan Azure Artifact Signing
Public Trust, Basic, under the verified legal business publisher. Microsoft
currently lists USD 9.99 per account/month including 5,000 signatures. Recheck
eligibility and actual billing before enrollment; the exact legal publisher,
Azure tenant/subscription and validated certificate profile are not established.
Identity validation requires the legal owner's participation in the Azure portal.
[Microsoft setup and eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart),
[Microsoft pricing tiers](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku).

Use short-lived CI federation scoped to a protected release environment and
the intended signing profile. Keep identity verification separate from signing
rights. The real package Publisher must exactly match the validated certificate
subject; preserve distinct pilot/stable identities, immutable versioned artifacts
and per-channel state. Verify trust, timestamp, extracted payload and clean-machine
install/update behavior before publication. The current preview identity and
unsigned artifacts cannot be promoted by renaming them. No paid resource,
identity submission, signing credential or public release was created by this
planning decision. The concrete sequence and remaining gates are recorded in EH
`windows-download/signing-route-plan-2026-10-23.md`.

## Build and signing pipeline

### Verified project-local packaging tools

On October22 the PC had no Windows SDK/Visual Studio packaging tools installed.
That does not require a global SDK installation: Microsoft's documented NuGet
route was exercised in a private tooling cache, outside the BCL-only app's
dependency graph. `Microsoft.Windows.SDK.BuildTools` version10.0.28000.2705
passed `dotnet nuget verify --all` with Microsoft author and NuGet repository
signatures. The exact nupkg SHA256 is
`8bfdfb6ca2633f531cf80b5fa22512ba61a394d7988f0970db83baadc67929ed`.

Its complete `bin/10.0.28000.0/x64` directory was retained. Before execution,
Windows Authenticode reported Valid/Microsoft Corporation for both tools:

| Tool | SHA256 |
| --- | --- |
| makeappx.exe | `98ddf5a4fdb38a1d32c2ca7b350a2012ed430d277baa1bf03ac91ef82365f1d3` |
| signtool.exe | `d6c04707c59a67fce9fa4bb5fe76c79445b60e1e326d8b500a2f2ba8707c590a` |

Both actual help commands ran successfully; MakeAppx reports10.0.28000.2705.
No package was built, signed or installed; no certificate or system PATH was
changed. Signature verification and help execution qualify this tool candidate,
not the final WPF payload or signing-provider integration. Before future use,
reverify the exact package/tool hashes and signatures rather than trusting the
cache directory or a mutable version lookup.
[Microsoft SDK-tools extraction instructions](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations),
[exact official NuGet package](https://www.nuget.org/packages/Microsoft.Windows.SDK.BuildTools/10.0.28000.2705).

### Required application preparation before the first package

The current desktop uses a strict but user-writable setup JSON file and one
`%LOCALAPPDATA%/LedgeTop/Files` state root. Parsing validates shape, not provenance.
Before packaging, bind endpoint/helper identity to a reviewed installed or
embedded release profile, reject mutable endpoint/helper overrides in packaged
mode, and derive distinct pilot/stable state roots from that trusted profile.
Keep principal/source subdirectories inside each channel. No user-selected
destination may become an application cleanup root. Do not silently migrate or
reuse another channel's durable queue.

Then produce an explicit self-contained x64 layout with the pinned helper and
required notices, manifest and visual assets. Build an unsigned candidate with
MakeAppx validation enabled, unpack it, and compare the expected manifest,
inventory and file hashes. An unsigned package is a build-test artifact only;
trusted signing, clean-machine install and update acceptance remain separate.

Before packing and again on the extracted application DLL, run
`scripts/windows-package-channel-check.ps1 -AssemblyPath <app.dll> -ExpectedChannel pilot`
(or `stable` for a reviewed stable build). This offline PE metadata guard never
loads application code. It rejects absent, duplicate, unknown or mismatched
compiled channel metadata, including an accidentally packaged developer build.
It does not verify the profile's endpoint/helper values, package signature or
manifest/channel identity; retain those independent package acceptance checks.

### Release build

1. Pin the reviewed SDK and dependency locks. Build self-contained Windows x64
   first; add arm64 only with native-runner acceptance. Produce an SBOM and retain
   the exact commit, runtime version, dependency hashes and build log.
2. Bundle a reviewed, hash-pinned official cloudflared Windows binary in the
   protected installation directory. Include its license/required notices.
   The app already checks the binary hash before each execution. Updating it
   requires a reviewed application release, never a PATH lookup or an unsigned
   runtime download. Validate supported human login/token behavior on that exact
   binary, rather than relying on master-branch documentation.
3. Choose the business's durable publisher identity and trusted code-signing
   mechanism before production packaging. Use managed signing or an existing
   trusted certificate; keep signing keys outside source, build output and the
   user's ordinary file storage. No certificate enrollment is completed yet.
4. Sign the package, timestamp using the signing provider's supported timestamp
   service, and independently verify trust, signature, publisher/manifest match
   and artifact SHA256 on a clean Windows machine. Reject untrusted, modified,
   mismatched-publisher and missing-signature packages.
5. Publish immutable versioned artifacts plus an App Installer descriptor only
   after tests and approval. The descriptor and all artifacts use fixed HTTPS
   origins; no repository token or end-user authentication secret is embedded.

Windows requires a trusted signature for installable MSIX packages. Development
self-signing can be isolated to a disposable test VM; do not ask clients to
disable signature enforcement or import a development root certificate.
[Microsoft MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview),
[cloudflared license](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)

### Qualified vendor candidate

On 2026-10-22, the official Windows x64 cloudflared `2026.10.3` asset
(`cloudflared-windows-amd64.exe`, 55,329,336 bytes) matched GitHub's published
SHA256 `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`.
Windows Authenticode verified publisher Cloudflare, Inc. Root independently
rechecked the local hash and signature. Actual version/help execution confirmed
the login `--app`/`--quiet` and token `--app` flags used by the adapter.

Retain this exact asset hash when evaluating packaging; GitHub marks the release
mutable, so a version tag alone is insufficient. The binary was qualified in an
owned temporary directory and was not installed globally. No login, token-cache
read or real authenticated desktop session was performed. Bundled-binary and
clean-machine runtime qualification remain open.
[Official release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3)

The candidate was reverified on October22 and staged with its exact upstream
root license in an owned private package-input cache. The adjacent evidence is
`docs/staging/windows-helper-package-inputs-2026-10-22.json`. The helper was not
executed or used for authentication in that step. The root license at pinned
upstream commit`de6376c5af4a67cbc65258682e5a01781827643d` has SHA256
`58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`.

No supplied notice/SBOM artifact was found among the release's uploaded assets
or its complete source tree. Root Apache2.0 license and Go dependency pins do
not establish complete attribution for the exact linked binary, whose Windows
amd64 build enables CGO. Retain that as a binary-publication requirement; private
unsigned bootstrap/helper tests can proceed with the verified inputs. Do not
claim complete third-party notices from this root-license observation alone.

### Runtime attribution progress, 2026-10-22

The previous unsigned preview omitted the redistributed .NET runtime licenses
and notices. The preview now invokes `windows-package-runtime-notices.ps1`
after publish and before inventory/packing. It checks the actual runtimeconfig
and dependency references against the reviewed self-contained x64.NET10.0.13
pair, verifies exact nupkg/file hashes, and retains the NETCore license and
third-party notices plus the WindowsDesktop license. Both nupkg signatures were
independently verified with `dotnet nuget verify --all`: Microsoft author and
NuGet repository signatures passed. WindowsDesktop's package lacks component
third-party notice files; unmodified WPF and Windows Forms notices are retained
from the package nuspec's exact Microsoft source commit. The receipt records
all five notice hashes and provenance. This closes those concrete omissions,
not every bundled component's licensing requirements.

`windows-helper-buildinfo.mjs` reads only the qualified hash-pinned helper,
without executing it. Its checked-in linked-module inventory records66 module
dependencies and three replacements, including two forks. It also reports
Go1.27.3, CGO enabled and `vcs.modified=true`. Therefore fetching licenses from
the main repository's `go.mod` alone is insufficient. The exact66 module ZIPs
were subsequently fetched from the official Go proxy, every Go content hash
matched the binary's embedded expected sum, and99 actual vendor notice texts
are retained with per-file/module provenance. The preview now includes those
texts and their manifest for the exact helper hash. Source-embedded notices and
per-subcomponent applicability still need review. The ten exact Go1.27.3
root/vendor LICENSE and PATENTS files have also been collected from the official
version's pinned source commit and included in an actually packed/unpacked
522-file unsigned candidate, with per-file/provenance hashes retained. Native
CGO/Windows-linked component provenance remains unresolved. The modified-source build marker also
means the public commit alone is not a complete source-provenance claim. The
package receipt deliberately continues to say `completeThirdPartyAttribution=false`.

Stable remains unconfigured in `ReleaseProfiles.For`; neither source visibility
nor a successful unsigned pack authorizes installing or publishing that channel.
Before distribution, choose a durable signed publisher and distinct reviewed
pilot/stable MSIX identities; compile each trusted profile; replace construction
artwork; and publish immutable versioned MSIX artifacts behind fixed HTTPS
download URLs. Use direct `.appinstaller` download links: Microsoft's current
documentation says the `ms-appinstaller:` protocol is disabled by default on
ordinary systems. The App Installer descriptor should use on-launch checks
without blocking activation, background checks, and omit
`ForceUpdateFromAnyVersion`; rollback remains a forward-version signed release.
The standalone `windows-appinstaller-preview.ps1` now constructs these settings
from the actual unsigned MSIX identity and matching construction receipt. Its
explicit preview mode uses reserved `.invalid` URLs and an `.xml` suffix; it
cannot create a usable update channel. Actual package/manifest/hash matching,
XML parsing and unsafe-input refusal were exercised against the 522-file
candidate, as recorded in `staging/windows-appinstaller-preview-2026-10-22.md`.
Signed production descriptors, Windows update behavior and clean-machine
install/update/rollback/uninstall tests remain unverified. No signing credential
is requested here.
[Microsoft current App Installer overview](https://learn.microsoft.com/en-us/windows/msix/app-installer/app-installer-file-overview),
[Microsoft update settings](https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings).

## Update, rollback and uninstall acceptance

### Signing route checkpoint

The local rehearsal in
`staging/windows-offline-signing-rehearsal-2026-10-22.md` conclusively rejected
SignTool's external `/dg` operation for this construction MSIX: SDK exit 1,
`0x80070032`, no digest or signed package. The input remained unchanged. It did
not test every signing approach or qualify the current runtime candidate.

For direct HTTPS distribution, the preferred production candidate is Microsoft's
Artifact Signing service, subject to the owner's publisher, eligibility and
subscription decisions. Its supported SignTool integration uses the provider's
`/dlib` plugin and requires an enrolled identity, certificate profile and signing
role. An existing trusted code-signing provider remains an alternative. Store
distribution offers Store-managed signing but changes the release channel.
None was enrolled or activated by this rehearsal. Retain the construction
publisher until the actual verified publisher and separate pilot/stable package
identities are settled; do not publish under the temporary identity.
[Microsoft signing options](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview),
[supported signing integration](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

Use App Installer's supported update mechanism rather than a custom privileged
updater. Pilot the chosen launch/background settings. An update must pause and
checkpoint transfers before replacing binaries, then renew human authorization
and resume only when logical file ID, remote version, length and SHA256 match.
Installing a newer build must never overwrite unrelated local files or restore
revoked access. Test updates during a partial transfer and with no network.

Do not enable arbitrary downgrade through the update descriptor. Rollback is a
new signed release carrying the last known-good behavior with a forward package
version. Test schema compatibility for queue/partial state before publication.
Uninstall removes application-owned registration and executable state while
preserving completed user downloads. Offer a separate explicit choice for owned
partials; never recursively clean an arbitrary user-selected destination.
[Microsoft App Installer update settings](https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings)

## Explorer online-only and offline files

Use Windows Cloud Files APIs for a later desktop provider, not fake sparse files
that look downloaded but contain missing content. Register a per-user sync root;
map provider identity to the signed-in human and opaque remote version. Hydration
must obtain fresh Ops/portal authorization and use the same verified range core.
Implement offline pinning, cancellation, placeholder repair, identity switching,
source changes, low disk, restart and uninstall recovery before offering it.
Downloaded bytes cannot be remotely recalled; revocation stops future reads.

The initial product is read-only remote delivery. A user editing a downloaded
copy must not silently overwrite server content. Writable employee sync still
needs a proven conditional-write contract that closes PR206's preserved-mtime
overwrite failure. Client R2 remains read-only.
[Microsoft Cloud Files platform](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine)

## Release gates still open

- Real staging employee and client sign-in, identity switching and per-user
  provisioning/revocation against both sources; no shared machine login.
- Large-file performance and interrupted resume, including files above 30 GB.
- R2 checksum coverage/backfill and employee gateway enrollment/temporary-storage
  sizing, using staging without touching TrueNAS.
- Live qualification of Claude's implemented unified browsing and transfer queue;
  its synthetic WPF acceptance is passing, not installed-user acceptance.
- Clean-machine signed install/update/rollback/uninstall acceptance.
- Separate Cloud Files placeholder/offline qualification before advertising it.

GitHub CI runs on main and pull requests. Feature-branch Engineering Hub tests
need an enrolled Ops runner; shared planning documents alone do not execute them.
