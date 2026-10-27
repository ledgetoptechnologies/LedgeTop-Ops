# Windows Explorer integration diagnosis

Status: October 27, 2026 UTC. Investigation, not a diagnosed repair or permission
to change package registration, trust, Windows settings or sync-root ownership.
The shared 0.5.3 candidate does not claim to fix missing Explorer actions.

## Evidence and remaining discriminator

The shared 0.5.3 source uses the same `LedgeTop Files Preview` display name for
generated and connected roots. A sidebar name alone therefore cannot identify
an obsolete demo. Removal must use the recorded root/context/namespace identity.
Comparing historical source `9ed7cc33` with `c8783723` found no change in the
registration creation settings: generated and connected sessions converge on
the same registration and placeholder provider. This comparison does not prove
the exact bytes of the earlier laptop ZIP or its runtime registration.

Later draft source separates new connected labels from the generated preview,
using schema-4 persisted display metadata. Existing schema-3 connected records
retain the legacy label and are not rewritten just to rename them. The new
label must match the bound source alias; it never supplies access authority.
Generated schema-2 cleanup is unchanged. This is a naming repair, not evidence
that Explorer menu/status behavior is repaired. The shared 0.5.3 bytes and v1
schema-3 diagnostic have not been replaced by this draft.

The laptop lists the approved Company photos and opens/downloads them. Its file
menus, including Show more options, lack keep/free actions and its Status column
is blank or unavailable. Earlier generated V2 testing confirmed the actions and
pin/free/reopen sequence on the Samples folder. These observations differ in
folder versus file, source, root generation and version; they do not establish
that every current child has the same Shell association.

Native hydration and direct pin/dehydrate tests qualify the filesystem callback
layer. They cannot establish visibility or behavior of Explorer's own menu.
The existing reviewed diagnostic must first bind the selected child to the exact
saved root/context/file ID, then observe the corresponding Shell association.
Fast cached-property absence is inconclusive. Do not reset a working connection,
change global Explorer preferences or install a custom verb as a guessed repair.

## Deployment support gap: meaningful, not proven causal

Microsoft's [Cloud Files guide](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine)
describes Desktop Bridge as an implementation requirement, separately describing
automatic hydration-state icons and standard context-menu actions. Its additional
custom-command integration is a different feature. The official
[CloudMirror manifest](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/CloudMirror/CloudMirrorPackage/Package.appxmanifest)
declares a cloud-files extension and packaged service handlers; the sample's
[README](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/CloudMirror/README.md)
deploys the package project. The combined sample cannot isolate which declaration
controls a particular missing built-in action.

Our release-channel assembly metadata means application configuration, not Windows
package identity. The conventional NSIS installer does not register an identity
package. The older generated Appx construction preview also lacks cloud-files
extensions. This leaves the documented packaged deployment model unqualified.
It does not prove that every native Cloud Files API rejects unpackaged callers.

There is also a useful counterexample in the official
[Nextcloud implementation](https://raw.githubusercontent.com/nextcloud/desktop/master/src/libsync/vfs/cfapi/cfapiwrapper.cpp):
it combines native CFAPI registration with explicit Shell metadata and distinguishes
full integration flags 34 from a mode suppressing CFAPI menus with flags 2.
Its comment allows VFS operation to continue when Shell metadata registration
fails. This reinforces the need to qualify both layers. Our metadata verifier
expects flags 34; its source constant is not a laptop readback. Do not copy GPL
code or apply broad registry changes as an experiment. Microsoft's
[manual integration schema](https://learn.microsoft.com/en-us/windows/win32/shell/integrate-cloud-storage)
is a reference for exact, read-only metadata comparison.

## Process identity is measured, not inherited by assumption

Native final-path checks found the desktop test observer's requested Roaming
shortcut paths resolving under the host's LocalCache/Roaming view. That blocks
physical Start-menu qualification; earlier same-view readback is weaker evidence.
It does not establish package identity of an exited native test or app process.

A separate current-tool-process query returned native code 15700 (NoPackage).
Only that exact observer process was queried. No package name, SID, account,
registry or existing file contents were returned. The redirected path observation
therefore must not be described as proof that the observer or app borrowed the
host's package identity. Microsoft recommends
[GetCurrentPackageFullName](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/packaging/)
for checking runtime identity. A future app query must bind its exact live PID,
start time and image; NoPackage must remain distinct from failed/unknown query.

The source now has a redacted current-process observer and separate pure policy
tests. An explicit metadata-only ExplorerTests invocation also returned 15700
(NoPackage) for that exact dotnet-hosted test process. It did not register a root
or read profiles, registry or app data. The two observations do not identify the
installed app, laptop, or earlier exited native-test processes. The observer is
not wired into app startup or the shared 0.5.3 candidate. Normal CI executes only
its pure classification mode, not the native observation mode.

## Signing and Store implications

An identity component can accompany an existing EXE installer without replacing
its update mechanism or requiring Store publication; Microsoft's
[external-location guide](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)
documents that model and executable identity manifests. Its end-user path requires
target-trusted package signing. Signing only the EXE does not create identity.

Windows 11 separately supports
[unsigned packages for testing](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package).
That requires an unsigned publisher marker and explicit AllowUnsigned. Executable
content generally entails administrator/all-user installation; the non-admin
exception is for non-executable content. Microsoft excludes broad distribution
from this test route. Its identity differs from a later signed identity.

Do not infer that a sparse package referencing an external executable qualifies
as non-executable merely because the EXE bytes are outside the archive. That
combination's deployment, privilege and Cloud Files behavior remain unqualified.
No identity package, certificate, trust entry, developer-mode setting, elevation,
Store enrollment or process-context workaround has been applied here.

## Next implementation gate

Keep the unsigned candidate and read-only source scope intact while collecting
the exact selected-child diagnostic and laptop 0.5.3 installation/Finish result.
Use measured process identity only as one discriminator. If evidence supports an
identity-based prototype, first freeze its bounded deployment, ownership, upgrade,
uninstall and later signed-identity migration plan. Do not register a package to
turn a hypothesis into an apparent successful test.
