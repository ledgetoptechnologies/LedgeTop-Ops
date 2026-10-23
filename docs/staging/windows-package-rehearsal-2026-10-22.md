# Unsigned Windows package construction rehearsal

This is a local build observation, not a released installer. No package was
installed, registered, signed, uploaded or offered for download. No certificate
trust, Windows settings, live endpoints, grants or TrueNAS/NAS changed.

## Source boundary

The authoritative run built a clean Git archive of desktop commit
`f50337f955be4f571a48a51dd8f92d81e3236465`, limited to `apps/windows-download`.
Archive SHA256 and Git subtree identity are pinned in the adjacent JSON receipt.
Artifacts, restore state and package files stayed in an owned private cache.

An earlier working-tree trial also packed successfully, but Claude began editing
the same worktree during this period. That trial is NOT source-pinned evidence.
It was superseded by this clean-archive build; its different package hash must
not be confused with the receipt's authoritative hash.

## Actual build and verification

The exact SDK10.0.402 published the WPF application as self-contained `win-x64`,
Release, without single-file bundling or debug symbols. Restore explicitly used
the official NuGet feed for Microsoft runtime packs; source NuGet configuration
and the app's BCL-only dependency graph were not edited. Runtime configuration
lists included .NETCore and WindowsDesktop frameworks10.0.13. This is not a
claim of acceptance on a clean machine without a global runtime.

The command from the archived `apps/windows-download` directory was:

```powershell
& $reviewedDotnet publish App/WindowsDownload.App.csproj -c Release -r win-x64 `
  --self-contained true --source https://api.nuget.org/v3/index.json `
  --artifacts-path $ownedArtifacts -o $ownedPayload `
  -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false
```

The rehearsal adds a Windows11 x64 manifest using Microsoft's documented
`packagedClassicApp`/`mediumIL` desktop model and `runFullTrust` capability.
The deliberately separate `LedgeTop.Files.BuildRehearsal` identity, placeholder
publisher, gray technical image assets and warning file are for this rehearsal.
They do not reserve a stable/pilot identity, specify the final signing publisher
or change Claude's application design. No protocol handler, startup task, file
association, Cloud Files root, service or privileged installer action was added.

MakeAppx's exact hash and Valid Microsoft Authenticode were checked before
execution. `pack /d ... /p ...` ran with validation enabled (no `/nv`), followed
by `unpack /p ... /d ...`. Both exited successfully. Every original relative
payload path, length and SHA256 was compared after unpacking; only generated
`AppxBlockMap.xml` and `[Content_Types].xml` were allowed as extra files.
The extracted manifest's identity, architecture and executable were checked;
no `AppxSignature.p7x` existed. No overwrite/retry or package registration command
was used.

The authoritative result is404 payload files,146,654,482 uncompressed bytes and
a64,328,138-byte MSIX. Exact package, inventory, manifest and script hashes are
recorded in `windows-package-rehearsal-2026-10-22.json`. The package, inventory,
script and logs are retained privately in
`C:/Users/fstor/.codex/cache/windows-package-rehearsal-f50337f9-clean/`.
No binary is committed or published. These hashes identify one observed build;
cross-machine reproducible-byte output has not been established.

## Next required package work

This old source intentionally has no trusted release profile or bundled helper.
Do not install it or treat the package's successful validation as runtime trust.
First finish reviewed immutable endpoint/helper bootstrap and pilot/stable state
isolation, then repeat this clean-source construction using the actual pinned
helper and notices, final manifest/assets and complete expected inventory.
The requested bootstrap work remains with Claude; port8770 was temporarily
unreachable during this run, so no new peer completion is assumed.

Signing-provider integration, trusted signed package verification, clean-machine
installation, helper execution, update/rollback/uninstall and live employee/R2
downloads remain separate unverified gates. The current EH staging execution
and gateway/TLS/enrollment requirements are unchanged.

[Microsoft manual package components](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
documents the desktop manifest and MakeAppx route used here. It also describes
registration; that registration step was deliberately not executed.
