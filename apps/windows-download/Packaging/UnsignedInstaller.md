# Unsigned manual pilot installer template

`UnsignedInstaller.nsi` targets NSIS 3.13 Unicode, per-user Windows 11 x64. It is
an unsigned manual installation candidate, not an automatic update service or
trusted/signed distribution claim. The official portable compiler is pinned and
available. An isolated diagnostic executable exercised the extracted path/version
helpers: eight path cases and 18 version cases per run passed, preserving an alias
destination sentinel. Thirteen static guards passed. These tests do not execute
the full installer or prove installed behavior.

The packaging builder must supply canonical four-u16 `APP_VERSION`, `OUTPUT_FILE`,
lowercase SHA-256 `PAYLOAD_MANIFEST_SHA256`, exact reviewed lowercase 40-hex
`SOURCE_COMMIT`, and `PAYLOAD_INCLUDE`. The latter must
be generated from the already verified immutable payload inventory and contain
only these macros:

* `InstallPayload`: explicit `File` entries, with `SetOutPath` for validated
  relative subdirectories; includes the release-profile app and dependencies.
* `DeletePayload`: explicit `Delete "$INSTDIR\relative-file"` for those files.
* `RemovePayloadDirectories`: deepest-first `RMDir` for their subdirectories,
  without recursive flags and without deleting the product/version parents.
* `ValidatePayloadPaths`: every unique payload parent directory, including
  `$INSTDIR`, with `Push` of its canonical path and `Call un.CheckPayloadPath`.
  Invoked before connection cleanup and again before the first deletion; missing
  directories are allowed, but nested junctions, files and unknown errors refuse.

Validate all components before NSIS generation: no traversal, absolute/UNC
paths, aliases, wildcards, NSIS metacharacters/control characters, duplicate or
reserved Windows names, or collisions with `installer-owned.ini`/`uninstall.exe`
or the reserved root leaf `installed-payload-inventory.json` (including a
case-equivalent directory with children).
Escape NSIS literals correctly. This include is trusted executable build input,
not a runtime data format. Inspect the actual built installer and payload hashes.

The builder snapshots the exact bounded inventory JSON bytes once, parses those
same bytes, and embeds them as the installer-owned root sidecar
`installed-payload-inventory.json`. It is not listed recursively in itself.
Generated install/delete macros include this one extra fixed file; generated
validation also refuses a sidecar directory, alias or unknown inspection error
before cleanup. Missing sidecars permit partial uninstall. Payload counts and
lengths continue describing the original inventory; construction receipts report
the additional sidecar separately. Original inventory bytes and the embedded
snapshot are checked again before a build can qualify.

The owner marker binds both `PayloadManifestSha256` and `SourceCommit`. The same
values appear in the installer's standard version-resource `Comments`, exactly
`LedgeTop.Files.Payload/1:<64-lowercase-hex-manifest-SHA256>:<40-lowercase-hex-commit>`.
The builder reads that resource back without executing the PE. A future upgrade
verifier must anchor marker and sidecar to its independently SHA-verified staged
installer, then verify every inventory entry; coherently edited installed marker
and sidecar alone do not establish authenticity. No upgrade activation is added
by this metadata. Legacy versions can still be manually upgraded forward: the
installer's existing-version gate does not require them to have the new sidecar.

The target is fixed to `%LOCALAPPDATA%\Programs\LedgeTop Files Pilot\versions\VERSION`.
Existing same-version directories are refused, even if they look complete;
failed extraction/preflight leaves the new directory for explicit review instead
of recursive rollback. Older versions remain on an upgrade. Unknown registry
metadata, same/lower versions, reparse ancestors and unsupported OS are refused.
No directory picker, Windows service or signing is configured. Start menu entries
and uninstall registration use HKCU/current user. The current source preserves an
optional exact-owned per-user Run preference across forward upgrades. Interactive
setup offers a checked Finish option to start the installed app; silent updates
never use that launch path. Scheduled update checks belong to the app and its
authenticated update protocol, not an installer background service. These source
features are not yet included in the shared 0.5.2 installer.

Before creating the fixed version directory, the installer stages the full
payload in its fresh NSIS-owned plugin temp directory and runs its new app's
read-only `--installer-check`. A running-app refusal therefore permits retry
after closing the app, without leaving a conflicting version directory. After
success it restores the fixed target, extracts there and checks once more before
activation. A late second refusal still retains the new directory for review.

`LedgeTop.Files.exe --installer-check` must perform the app's fixed-profile,
read-only maintenance preflight before activation: exit 0 permits activation,
10 means an app instance is running, 20 means ownership is ambiguous/refused.
Launch failures and every other nonzero code abort. Existing activation is kept
when extraction or this preflight fails. Registry/shortcut write failures after
activation starts require explicit review; activation is not transactional.

The active version's uninstaller first proves its fixed version path, exact HKCU
`InstallLocation`, owner marker/version/payload-manifest digest, and directory
shape. An older retained version's uninstaller refuses before connection cleanup.
It invokes its own `--installer-remove-connections`, with the same exit contract,
before deleting payload files. This CLI must drain native work and positively
verify/remove only owned integration; it must preserve local files and return 20
on ambiguity. Failed cleanup deletes no payload. No force-kill, broad directory
delete, profile/root/cache/download deletion, or automatic old-version pruning.
The current source also handles the exact recorded generated V2 Preview during
this explicit uninstall. It validates both connected sources, then performs one
singleton-held legacy cleanup before connected removals; partial multi-root
cleanup is not atomic. A retry verifies recorded physical-root and native/Shell
absence without repeating unregister. Missing legacy records are not proof that
an untracked entry is absent. The separate packaged-pilot command
`--installer-remove-legacy-preview` touches only that recorded old preview and
refuses missing/unknown ownership. Neither command removes local file contents.
New pilot app startup also observes the installer mutex before any provider work;
maintenance children bypass that gate. Earlier portable builds lack it. Installed
acceptance must still cover launch races and locked-file refusal before release.

Run `node --test apps/windows-download/Packaging/UnsignedInstaller.test.mjs` for
static safety guards. `scripts/windows-installer-runtime-probe.ps1` compiles and
runs a separate temp-only helper diagnostic from the template's extracted
PathCheck, payload-parent checker and version parser. It substitutes one logging
assignment/return per dialog/abort, preserving jump instruction positions. It
does not execute the installer or alter registry, app, profiles or shortcuts.
Required subsequent acceptance: actual full-template compiler validation,
new install, active-app refusal, newer-version upgrade with old payload retained,
old-uninstaller refusal, cleanup refusal, alias/unknown-receipt refusal, uninstall
with user files kept, shortcut/registry failure, and reboot/locked-file cases.
Do not claim installation or update acceptance until those runs have receipts.

Primary references:
https://nsis.sourceforge.io/Reference/RequestExecutionLevel
https://nsis.sourceforge.io/Docs/Chapter4.html
https://github.com/nsis-dev/nsis/blob/master/Include/WinVer.nsh
