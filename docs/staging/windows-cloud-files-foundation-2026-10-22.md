# Windows online-only groundwork acceptance

This supplements PR236 at `306273391fc7b38dcfc4b69a868d6fb4ad26e307`.
It does not activate a Cloud Files provider or change the existing desktop UI.

## Implemented boundaries

- `CloudFilesProbe` calls the Windows platform API and inspects one literal local
  file's metadata without opening its data stream. System32 DLL loading, fixed
  physical drive checks, ancestor reparse checks and bounded literal paths keep
  the probe conservative. It reports unavailable APIs and native failures
  separately from successful metadata reads.
- `PlaceholderIdentity` binds channel, source, verified principal and immutable
  content pins within the native 4096-byte identity limit. The encoded identity
  is not authorization and contains no expiring byte URL or session credential.
- `PlaceholderHydrationCoordinator` reuses the existing authenticated download
  source contract. It stages a whole file in separate owned cache storage,
  verifies SHA-256 under a handle that denies writes/replacement on Windows,
  rechecks current authorization, and then emits bounded aligned ranges to an
  injectable sink. No unverified network chunks reach the sink. Root and entry
  locks prevent competing cache users from racing quota admission or publication.

Root combined independently reviewed commits `eecd6c61` and `2b69ea86`, plus
`6cef2b26` to match the downloader's DOS device-name exclusions.
Their only overlap was test registration; both sets remain registered.

## Verification

Pinned .NET SDK10.0.402, Windows x64, Release configuration:

```powershell
dotnet run --project Tests/WindowsDownload.Tests.csproj --configuration Release
```

All **73/73** transfer groups passed. Coverage includes actual Downloader
verification into temporary cache files, cached-file tampering, post-download
revocation/principal/version/source drift, cancellation, cache ownership and
capacity exclusion, UTF-8 identity size boundaries, overflow/alignment rejection,
EOF ranges and accumulation of deliberately short reads into aligned writes.

The actual native probe reported platform build26100, revision9278,
integration1576. The owned ordinary temporary file reported placeholder state0;
its bytes, attributes and modification time remained unchanged. The fixture was
removed. This proves that the read-only probe ran on this machine; it does not
prove Explorer, placeholder or offline functionality.

Desktop regressions also passed **19/19** groups, including actual WPF rendering,
identity changes, queue cancellation and window shutdown. The final device-name
follow-up changed only the new probe and its tests; the combined73-group suite
was rebuilt and rerun afterward. Desktop screens and existing download behavior
were not modified.

## Product work still required

1. Connect a native provider only in a disposable Windows test environment:
   register an owned NTFS root, validate callback ABI/lifetimes and cancellation,
   and bridge verified ranges to `CfExecute`.
2. Test hydration, pin intent versus actual offline availability, offline opens,
   crash/restart, identity changes, low disk and safe provider removal. No policy
   may claim to revoke bytes that have already been downloaded.
3. Define bounded cache eviction and offline authorization policy. The present
   coordinator deliberately has no automatic deletion or eviction behavior.
4. Qualify live staging employee/container and client/R2 transfers, provisioning
   and real human session expiry through the separately prepared composition.
5. Complete signing, publisher selection and clean-machine install/update/
   uninstall acceptance before distributing an installer.

Whole-file verification means initial hydration waits for the full download and
requires additional local cache space. Fast authenticated partial hydration
needs a reviewed chunk-integrity contract; relaxing SHA checks is not a substitute.
Writable sync remains disabled. No TrueNAS/NAS, cloud data, grants, installed
provider, system trust or production deployment was changed by this acceptance.

## Native transfer and callback follow-up

The same draft now includes native slice `fe4e4eec` and callback lifecycle
`66ba2a5b` plus cancellation-drain correction `13e6d5b3`. Root combined these
without changing the existing app entrypoint or UI. Both test families remain
registered. The rebuilt combined transfer suite passed **86/86** groups.
The combined desktop regression run also passed **19/19** groups, including
WPF rendering, identity changes, queue pause/resume and shutdown. It used demo
data and no production network or installed provider.

The internal x64 adapter builds `CF_OPERATION_INFO` and transfer parameters,
holds a copied buffer pinned through a synchronous native call, and releases it
after return. Tests inspect the actual unmanaged structures and pinned bytes
through an injected native boundary. The final successful transfer is the native
commit point; a cancellation racing afterward cannot issue a contradictory
failure. No separate native completion operation is invented.

A truthful indeterminate progress heartbeat runs while the whole-file cache is
downloaded and verified, and is joined before final transfer or failure. [Microsoft
documents](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfreportproviderprogress)
that periodic provider progress resets the fetch callback's60-second
timeout. Tests exercise progress failure, cancellation observers throwing, and
the final-call cancellation race without invoking real transfer/progress APIs.

The dispatcher copies bounded callback identity data, checks its provider scope,
normalizes EOF length, deduplicates matching active requests, and permits fresh
authorization for later reuse of an opaque request key. Its limit applies to
active work, not the lifetime number of fetches. Stop rejects new work and waits
for native work, keepalive and asynchronous cancellation observers before
disposing state. A blocked-observer regression proves that retirement waits.

Independent review reran79 native-slice groups and80 callback-slice groups.
The latter used the exact final native dependency for its combined boundary test.
Root's86-group run includes both families against the integrated source.

Primary header provenance is pinned to Microsoft win32metadata commit
`2f767671802301cf043c717d66bf004ed7863487`:

- `um/cfapi.h`:34871 bytes, SHA256
  `9926ab4f658d2e84f10c82bb90ef8026fcfc79f16e06cbc4340106cbabae3e89`.
- `shared/ntstatus.h`:688716 bytes, SHA256
  `457c375cd907d235d4f036ed9262ff9f245becf55c819bb3d1d1323c03d0195f`.

Root and reviewer independently rehashed these public headers. Managed size and
offset checks are not a compiled Windows SDK or registered-provider ABI test.

Subset cancellation, simultaneous conflicting ranges under one opaque request
tuple, zero-length native fetches, the unmanaged callback trampoline and real
registration remain unsupported or unimplemented. These limits must be resolved
and tested in the disposable Windows lane before activating a provider. Explorer,
pin/offline, eviction, signing and live staging gates above remain open. This
follow-up made no real `CfExecute` or `CfReportProviderProgress` calls.
