# Windows desktop live staging acceptance

This is an opt-in developer console, not an installer, a production qualification,
or permission to create grants. It references the real Core project and the exact
source-controlled Pilot connection profile (including official cloudflared hash).
It uses normal certificate validation and the real human Access session; it has
no synthetic JWT runner, certificate override, database seeding, credential file,
upload, grant mutation or local test-control endpoint. Existing loopback transport
executables remain unchanged.

## Prerequisites

Use Windows, the reviewed .NET 10 SDK, and the reviewed official cloudflared
2026.10.3 Windows amd64 helper. Its SHA256 must match `ReleaseProfiles.For(Pilot)`.
Review that profile's exact staging origins and protected application paths before
running. The harness has no origin/hash override. Sign into the selected human
Access application separately; the harness only asks the real session for its
cached token and never starts browser sign-in or tries another identity.

The supported owner workflows must establish exactly one dedicated synthetic
`map.bin`, 2,097,152 bytes with its independently recorded SHA256. Employee mode
selects an exact root UUID returned by Ops. Client mode selects an exact, unique
synthetic delivery display name returned by the portal; its root folder must have
only `map.bin`, no child folders or pagination. No arbitrary file URL is accepted.
Administrator status alone is not a file grant. Owner admission and the explicit
`employee.files.manage` permission are needed for employee provisioning. Portal
recipient, project, folder, publication and delivery authority must come from
their supported issuers, with no fabricated active D1 rows.

## Commands

From `apps/windows-download`, first compile in the agreed serialized build window:

```powershell
$dotnet = 'C:/Users/fstor/.codex/cache/windows-download-dotnet-10.0.402/sdk/dotnet.exe'
& $dotnet build LiveStagingAcceptance/WindowsDownload.LiveStagingAcceptance.csproj -c Release -p:UseSharedCompilation=false
```

For each source, choose a fresh UUID and keep the same arguments across phases:

```powershell
$harness = 'LiveStagingAcceptance/bin/Release/net10.0-windows/LedgeTop.WindowsDownload.LiveStagingAcceptance.dll'
$run = [guid]::NewGuid().ToString('D')
$helper = 'C:/ABSOLUTE/REVIEWED/cloudflared.exe'
$sha = 'INDEPENDENT_LOWERCASE_64_HEX_FIXTURE_SHA256'
$selection = 'EXACT_SYNTHETIC_ROOT_UUID_FROM_OPS'
& $dotnet $harness --phase interrupt --mode employee --run-id $run --helper $helper --sha256 $sha --selection $selection
& $dotnet $harness --phase resume --mode employee --run-id $run --helper $helper --sha256 $sha --selection $selection
& $dotnet $harness --phase existing-destination --mode employee --run-id $run --helper $helper --sha256 $sha --selection $selection
& $dotnet $harness --phase after-revoke --mode employee --run-id $run --helper $helper --sha256 $sha --selection $selection
```

Repeat with a different run UUID, `--mode client` and the exact synthetic delivery
display name for `--selection`. Do not use actual client files.

The last phase must start **before** revocation: it resolves a current manifest
into memory, prints a redacted `armed-awaiting-owner-revocation` event, and waits
up to 90 seconds. Revoke only the synthetic grant through its supported owner
workflow, verify its receipt, then enter `REVOKED`. It proves that discovery,
durable-reference resolution and that in-memory saved byte selector deny, while
the already downloaded local copy remains unchanged. Login failure, timeout or
transport error does not count as successful revocation. The harness does not
independently attest the operator's owner receipt or distinguish grant revocation
from another simultaneous server-side authority change; retain the owner/audit
evidence separately.

## What the phases establish

`interrupt` obtains server-derived discovery and reference information and uses
the real `TransferQueue` and source to begin downloading. A synchronous observer
waits 150ms at initial zero progress, beyond the production observer's 100ms
throttle. The first nonzero, at-most-64KiB write then calls normal `PauseAsync`
without awaiting its own transfer from the observer. The phase requires Paused,
one nonempty bounded partial and no final file. It exits normally; `resume` must
run in a distinct process, reopen the same durable queue, reauthenticate, resolve
fresh pins and finish with exact size and SHA256. The production Downloader
requires the matching Range/Content-Range on retained-prefix resumes. This tool
does not independently capture wire headers or claim a hard process crash test.

`existing-destination` creates a unique owned sentinel and requires the actual
downloader to refuse replacement while preserving its digest. Each successful
phase writes a create-new receipt and refuses to overwrite it. No cleanup or
automatic retry is performed.

Local artifacts live only beneath
`%LOCALAPPDATA%/LedgeTop/Files/live-staging-acceptance/<run UUID>/`.
The root marker pins source, fixture digest and a digest of the selection. Queue
state uses the production non-authorizing reference format and expected pins;
it includes the fixed source origin, as the desktop normally does, but no token
or byte selector. Receipts/stdout omit identities, selectors, paths and URLs.
Errors report only exception type. All roots and ancestors reject reparse paths.
The normal cloudflared per-user token cache remains owned by cloudflared, and is
not read directly, copied or included in receipts by this tool.

Keep both source receipts, exact source/deployment/schema/gateway/desktop hashes,
owner grant/revocation receipts and independent audit evidence. A successful
desktop test does not establish production release, installer/signing, Windows
placeholder hydration, employee writeback, EH execution permission or NAS access.
