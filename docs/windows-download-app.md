# Operations Windows download app

Status: tested transfer foundation, human portal and employee adapters, audited
employee provisioning and unmounted read routes, started 2026-10-21. This is not a released desktop client, a live-qualified
Operations integration, a sync service, or an Explorer files-on-demand provider.

PR250 is the current integration review. PR234 and PR235 preserve the earlier
client/employee component history; their existence does not mean the routes are
live. See [the private gateway protocol](employee-read-gateway-protocol.md)
and [the employee API](employee-windows-api-draft.md),
and [the concrete installer/release plan](windows-download-release-plan.md).
Their routes remain unmounted; no host folder access is granted by installation.

The current source also implements durable queues and publication-continuous
portal browsing/downloads. See [the catalog contract](windows-portal-catalog-contract.md)
and [the staging activation packet](windows-files-staging-acceptance.md) for the
current integration boundary. Historical test counts below describe their named
checkpoints; Engineering Hub and the draft PRs retain current exact-head evidence.

The reviewed queue repair `a6e735f4` passed an independent exact-source 31-group
App run. Its unchanged Core reservation input `a3080c8d` passed 103 synthetic
groups. The repairs fence newer local stops, stale background saves, repeated
Resume requests and late callbacks from older invocations. They are source
evidence, not live sign-in or installed-package acceptance. The selected-source
backend `61a6dde1` passed 32/32 App groups and independent source review. It
constructs only the selected source and rejects foreign aliases before adapter
calls; its default is client mode. Packaged startup selection is still in
progress; no client should need staff authorization to use the app.
Per-source opaque principal IDs are
not interchangeable proofs that two cached sessions belong to the same person.

## Product direction

One Windows application should show the signed-in person's authorized files.
Employees receive approved server folders through an HTTPS service running in
the existing server-container model. Clients receive read-only deliveries from
private R2 through the portal's authorization layer. A person who has both roles
can see both kinds of resource without managing separate workspace identities.

Operations owns provisioning and access decisions. Neither a client identity nor
an installer receives an R2 bucket key, an SMB password, a server administrator
credential, or access to the private source repository. Financial documents and
financial authoring remain in Project Alpha.

## Existing evidence

The earlier employee-file experiment is [draft PR206](https://github.com/ledgetoptechnologies/LedgeTop-Ops/pull/206),
head `4445c819e6c7628a74ec5dc65296c8dc0acb45fe`. It is an isolated Nextcloud
service pilot, not a Windows application. Its captured acceptance passed eleven
groups and failed the twelfth: a same-size edit preserving modification time
retained its ETag and allowed a stale conditional overwrite. Keep that failing
test as evidence. Do not release writable employee sync on that basis.

The pilot did not implement or verify a Windows installer, desktop sign-in,
Explorer placeholders, offline pinning, or client R2 delivery. A stock Nextcloud
desktop client cannot simply be configured as a custom R2 client.

## First implementation boundary

`apps/windows-download` contains a small .NET transfer prototype, with synthetic
test data and no production credentials or service enrollment. Its first gate is
safe download completion: a strong version identifier, expected length and
SHA-256; validated resumed responses; cancellation and interruption handling;
and atomic completion that preserves existing local files. It must not upload,
delete remote content, follow arbitrary redirects, or overwrite a user's file.

The prototype's transfer metadata is not a new authorization mechanism. The
implemented adapters obtain identity-bound resource handles, current access and
trusted content metadata from the server. Origin configuration
must come from trusted application configuration, not a downloaded file listing.
The server must provide a usable strong version and content hash before a real
delivery can pass this integrity contract. An R2 ETag must not be assumed to be a
SHA-256 digest, particularly for multipart uploads.

### Current portal interface and missing contracts

The reviewed main source (`9f9418df`) already has the native route family under
`/api/client/operations/data`: delivery listing, folder/file handles, and
`GET`/`HEAD /files/:fileHandle/download`. The download route supports range and
conditional reads, including `206`/`416`, ETag and content length. It still checks
the human Access identity and current Operations resource grant. Do not replace
those checks with a broad desktop service credential or loosen allowed origins.

The native encrypted handles expire after fifteen minutes and are bound to a
person, grant and publication version. They are not standalone authorization or
a durable queue identity. Re-list after expiry and resolve a stable logical file
identity before resuming. Current ordinary file DTOs do not supply a trusted
SHA-256 for file bytes; publication snapshot hashes describe JSON, not content.
The reviewed routes have no custom desktop OAuth exchange. The first adapter
instead reuses Cloudflare's official human cloudflared login and cached-token
mechanism against the fixed protected portal application URL. This preserves
the existing portal audience and person-bound authorization, without a new
delegation service or shared machine credential. Live staging acceptance remains
required; source tests do not establish that an installed desktop is connected.

The source now adds an authenticated native `download-manifest` route. It reads
R2 checksum metadata and returns a version-pinned encrypted download selector,
opaque stable logical ID and trusted content fields. Existing byte routes enforce
version and checksum pins before returning data. Missing R2 SHA-256 fails closed;
existing/multipart file coverage requires a version-fenced streaming checksum
job or ingestion proof. No large file is buffered or hashed in a Worker here.

Employee access now has an exact staff-to-managed-root read-grant family,
audited provisioning and server Docker gateway in source. Real staging enrollment
and human acceptance remain open. Existing profile-directory grants are not file grants,
and R2 prefixes must never be translated into arbitrary server paths. Start that
gateway with read-only synthetic mounts and strict native staff admission; keep
the preserved-mtime stale-write failure as a hard gate against writable sync.

Keep the original interrupted transfer on a changed remote version. Obtain fresh
metadata and restart explicitly; never append content from two versions. An
expired download authorization must be refreshed through the signed-in control
plane, not stored indefinitely in a queue file. Queue metadata and logs must not
contain bearer tokens or signed download URLs.

## Milestones and acceptance

Local evidence at employee commit `e0ee82e5`: 37/37 Windows acceptance groups
(including a real owned subprocess fixture), 184 focused Ops tests, full Ops
typecheck and 24 source-layout checks pass. The unchanged gateway passed 67 Linux
tests at `db0136a3`. Prior client source passed typecheck and 113 native tests at
the PR234 checkpoint. Independent review found no blocker in the unmounted
adapters, read/provisioning routes and migration. These are synthetic/local results, not
Engineering Hub execution, a live human login, or customer rollout acceptance.
GitHub could not start the new-head jobs because of an account payment/spending
limit block; required current-head checks are not claimed green. The durable queue
contract is being implemented separately; see
[the queue draft](windows-queue-contract-draft.md).

1. **Transfer foundation:** run deterministic synthetic tests on Windows for
   interruption/resume, cancellation, changed versions, invalid ranges, corrupt
   or oversized content, unsafe names and existing local files. Publish only
   local developer artifacts at this stage.
2. **Authenticated read-only integration:** specify and implement browser-based
   sign-in and a device/session handoff. Reuse the portal's exact resource and
   authorization contracts, with explicit employee-server versus client-R2
   routing. Prove unauthorized and cross-client denials, expired sessions,
   revoked access, bounded URLs and safe retry. Do not embed a service identity
   that bypasses per-user permission checks.
3. **Windows application experience:** provide the authorized file list, queue,
   progress, pause/cancel/retry, destination selection and recovery after restart.
   Keep UI work coordinated with the existing Operations design work. Qualify
   every supported Windows architecture and filesystem; no Explorer integration
   is implied by an ordinary downloader.
4. **Installer and updates:** produce a reviewed, signed installer, verify clean
   standard-user installation/update/uninstall, and test failed updates and
   rollback. Keep completed user downloads on uninstall. No background service,
   scheduled task or automatic startup is needed for the initial downloader.
5. **Explorer files on demand:** separately implement and test a Windows Cloud
   Files provider on a disposable NTFS sync root. Cover hydration, cancellation,
   pin/unpin, offline reads, sleep/restart, changed remote versions, full disk,
   safe uninstall and local-edit preservation. Writable sync remains a separate
   milestone requiring a reliable revision/conflict model.

Already downloaded copies on an unmanaged device cannot reliably be recalled.
Signing out or revoking access stops future authorized requests; it does not
justify claiming previously downloaded files disappear. Document any remaining
lifetime of an issued download capability.

## Packaging and publication recommendation

Use a small C# desktop application and a reusable transfer library. Begin with
ordinary HTTPS downloads; add native Cloud Files callbacks only after the first
application is stable. A self-contained Windows build avoids requiring clients
to install a .NET runtime separately. Retain exact SDK/dependency and build
evidence with the artifact.

Prefer signed per-user MSIX if the final application fits its packaging model.
Use MSI if a later native integration requires installation behavior that the
chosen MSIX model cannot support. MSI alone is not an automatic-update system.
Certificate trust, timestamping, publisher identity and a rollback policy are
release gates; an unsigned local test executable is not a customer release.

Keep the Operations repository private. Promote approved signed binaries to a
separate HTTPS download channel, linked from Operations and the client portal,
with checksums and release notes. Default to authenticated distribution while
the channel is being designed; do not make private repository assets public or
ship repository credentials. Test App Installer feed authentication separately:
its update process cannot be assumed to share the browser's Operations session.
No signing purchase, public binary publication, production access change or
TrueNAS operation is part of this prototype.

The requested GitHub policy remains main pushes and PRs only. Feature-branch
testing belongs in Engineering Hub once an Ops runner is enrolled. Shared notes
are tracking, not proof that the runner exists; retain local Windows test
evidence until that execution path is operational.

## Primary references

- [Microsoft Cloud Files engine overview](https://learn.microsoft.com/en-us/windows/win32/cfApi/build-a-cloud-file-sync-engine)
- [Cloud Files connection callbacks](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfconnectsyncroot)
- [Pin state and provider responsibilities](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfsetpinstate)
- [Windows distribution choices](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path)
- [Self-contained .NET publication](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)
- [MSIX package signing](https://learn.microsoft.com/windows/msix/package/signing-package-overview)
- [App Installer distribution](https://learn.microsoft.com/en-us/windows/msix/app-installer/app-installer-file-overview)
- [App Installer update behavior](https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview)
- [Access to GitHub release assets](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)
- [Cloudflare human CLI authentication](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
- [R2 upload versions and stored checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
