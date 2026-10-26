# Unsigned manual pilot installer template

`UnsignedInstaller.nsi` targets NSIS 3.13 Unicode, per-user Windows 11 x64. It is
an unsigned manual installation candidate, not an automatic update service or
trusted/signed distribution claim. The official portable compiler is pinned and
available. An isolated diagnostic executable exercised the extracted path/version
helpers: eight path cases and 18 version cases per run passed, preserving an alias
destination sentinel. Thirteen static guards passed. These tests do not execute
the full installer or prove installed behavior.

The packaging builder must supply canonical four-u16 `APP_VERSION`, `OUTPUT_FILE`,
lowercase SHA-256 `PAYLOAD_MANIFEST_SHA256`, and `PAYLOAD_INCLUDE`. The latter must
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
reserved Windows names, or collisions with `installer-owned.ini`/`uninstall.exe`.
Escape NSIS literals correctly. This include is trusted executable build input,
not a runtime data format. Inspect the actual built installer and payload hashes.

The target is fixed to `%LOCALAPPDATA%\Programs\LedgeTop Files Pilot\versions\VERSION`.
Existing same-version directories are refused, even if they look complete;
failed extraction/preflight leaves the new directory for explicit review instead
of recursive rollback. Older versions remain on an upgrade. Unknown registry
metadata, same/lower versions, reparse ancestors and unsupported OS are refused.
No directory picker, startup task, background download, signing, or app launch
is configured. Start menu entries and uninstall registration use HKCU/current user.

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
