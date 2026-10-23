# Verified hydration coordinator rehearsal

This source-only slice adds `PlaceholderIdentity` and
`PlaceholderHydrationCoordinator` under `apps/windows-download/Core`. It does
not register a Cloud Files provider, create placeholders, set pin state, hydrate
Explorer files, install software, or change the desktop startup path. The
existing app and download queue remain unchanged.

## Concrete contract

A future native adapter supplies a validated identity and a bounded range to an
`IPlaceholderTransferSink`. The identity codec accepts only its exact versioned
JSON shape, known pilot/stable channel, fixed source alias/origin, verified opaque
principal, resource reference, logical identity, immutable version, name, length,
strong ETag and SHA-256. It carries no credentials or expiring byte URL. The
encoded identity is limited to **4096 bytes**, matching Cloud Files' FileIdentity
ceiling. A valid server queue reference can exceed this limit; that reference is
explicitly unsupported here rather than truncated. A later compact local lookup
identity would need its own durable ownership/repair contract.

Offsets must be 4096-byte aligned. Length must be aligned except for a range
ending at EOF. The coordinator accumulates short stream reads with
`ReadExactlyAsync` before passing each aligned block to the sink. This matches
the transfer-data constraints, but does not qualify native ABI/layout behavior.
The sink gets exactly one terminal Complete or Fail call; a throwing terminal
callback never causes a second terminal call.

Every hydration obtains current session and resolves the non-authorizing
reference. It matches principal and every immutable pin. Source alias/origin are
checked again after each authorization await, and the resolved byte URL must
remain on that exact HTTPS origin. After the full download **and a fresh cache
hash**, the session and authority are checked again before any sink bytes.
Callbacks do not initiate browser sign-in or automatically retry denied work.

The whole file is staged with the existing verified Downloader in a separate
cache. SHA verification finishes before any sink byte is sent. The existing
Downloader's reparse-point rejection remains unchanged; it is never pointed at
a Cloud Files placeholder. A FileShare.Read handle denies concurrent Windows
writes and replacement through hashing and range transfer. Placeholder hydration
cannot safely reuse the downloader's unverified network chunks: current metadata
has a whole-file SHA, not independently trusted chunk hashes.

Cache state is under an existing **private, local, app-controlled** state root,
with application owner markers and nested scope hashes for channel, source,
origin and principal, then immutable identity. Reparse paths and unowned cache
directories are rejected. A root FileShare.None lease serializes capacity checks
and downloads across coordinator instances/processes; an occupied lease fails
closed rather than bypassing limits. Defaults cap a file at64GiB and the cache
at128GiB. No eviction or recursive cleanup is performed. Corrupt cached data
fails closed and is retained for explicit repair. Scope markers are ownership
checks, not a sandbox against a hostile local user concurrently replacing paths.

## Evidence and limits

Run from the repository root with the pinned .NET10.0.402 SDK:

```
dotnet run --project apps/windows-download/Tests/WindowsDownload.Tests.csproj
```

On October22, all70 test groups passed. The seven added groups run real local
full downloads with the actual Downloader, SHA verification and temporary cache,
then verify exact sink bytes and aligned offsets. They exercise post-download
revocation/principal/version/hash/ETag/source-origin changes, a foreign byte URL,
denied cached reuse, cache and transport corruption, cancellation after a block,
unsafe ranges/overflow, channel/source isolation, unowned roots, cache capacity,
Windows write exclusion, concurrent coordinator exclusion and throwing terminal
callbacks. The codec tests exact4096/4097-byte bounds, duplicate/unknown/missing
fields and unsupported version. A stream deliberately returning13-byte chunks
proves short reads cannot create unaligned sink transfers.

This adds whole-file latency and needs disk space for both the cache and the
future hydrated file; it does not meet the final low-storage/instant range-read
experience for30GB+ jobs. Actual NTFS Cloud Files registration, callback lifetime,
process restart, placeholder identity repair, pin/unpin/dehydrate, low disk,
partial-placeholder cleanup, native cancellation, uninstall and offline policy
need a separate disposable Windows test environment and native adapter.

`CfSetPinState` records user intent, not proven offline availability. No pinning
or availability state machine is implemented here. Fresh online authorization
gates each new hydration, including cached reads. Already delivered/offline
bytes cannot be remotely revoked or recalled, and this code does not erase user
copies. Offline authorization grace and the product policy for offline opens are
not implemented. No Explorer or installed-user acceptance is claimed.

Official references checked October22:

- [Cloud Files architecture](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine)
- [Placeholder identity limit](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_placeholder_create_info)
- [Transfer-data alignment](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_operation_parameters)
- [Pin intent](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfsetpinstate)
