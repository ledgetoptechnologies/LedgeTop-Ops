# Windows composite source and construction acceptance

Desktop commit: `ba7a3e79ae850ab66402acc633f35fc8d3654091`.
Windows source tree: `8fe665bc43a22e4ccd0d15752fc1b32ef8ce0d63`.
Clean Git archive SHA256:
`5a89948b05efcb07da180c0e7bd2e0f1da10759b7b3f859303dc8ed1f0f92df1`.

An independent exact-source run of AppTests/WindowsDownload.App.Tests.csproj
in Release with SDK10.0.402 exited0:19/19 synthetic app groups passed. The suite
uses the real transfer queue and temporary local files with demo sources. It
does not use credentials, network or client data. It covers startup/sign-in,
compiled package profiles, verified/no-overwrite downloads, expiry, account
switching, pause/resume, pagination, close during startup, close during transfer
and close while a previous person's queue is still draining. The startup group
also races two source-open paths, verifies one pending owner, then closes and
checks released locks/no late Files screen. Actual WPF file/sign-in/setup screens
rendered; the files image was visually inspected.

Read-only independent review compared exact Git objects with the previously
tested isolated ownership patch. The composite retains closed-before-auth
guards, serializes EnterOnceAsync, tracks every detached drain, joins captured
drains during close and rechecks closed after retirement. No remaining concrete
blocker was found in those paths under the existing UI-dispatcher model.

The committed tests pass with the corrected product. Claude separately owns a
test-only cleanup improving release of held gates on a deliberately broken
negative control; that uncommitted work is not part of this exact-source result.

The repeatable construction script then built the same immutable source using
the compiled pilot profile and pinned helper/root license. Validated pack,
unpack, pre/post PE checks and exact extracted inventory all passed; process
exited0. Receipt: `windows-composite-package-2026-10-22.json`.406 payload files,
202011047 bytes; unsigned MSIX83587400 bytes, SHA256:
`57bdd9a6fcb59522fc5f16101048d6d0bcf4a3366ba1dbce8bf7d80a5d753440`.
Application DLL SHA256:
`f4b108999b1a015623cc7396d47d12b3c45c7727e00b0a9abcd66bcf0dd99aca`.

The package receipt intentionally says runtimeTestsExecuted=false and
sourceAcceptanceVerified=false: the construction script does not execute tests
or certify source. This document connects the separate exact-source synthetic
result to its matching archive. Neither result establishes live desktop access.

Evidence remains in private local cache
`C:/Users/fstor/.codex/cache/windows-composite-ba7a3e79-ee3152d0489c4bc19e1cbac4adc815d8`
and the unique preview root recorded in the package receipt. No package was
installed, signed, registered, uploaded or published. No TrueNAS/NAS access,
live migrations/grants, production deployment or writable sync occurred.

Remaining gates retain the original scope: live EH execution/enrollment and
protected TLS gateway; exact staging schema checkpoint/reconciliation; real
human employee and authorized client R2 sign-in, interruption/restart/range
resume/identity-switch/revocation; checksum coverage and large-file resource
qualification; complete attribution and signed clean-machine installation,
update/forward rollback/uninstall. Cloud Files hydration/offline pinning remains
a later separately qualified provider step. This source/construction result is
not release or whole-goal completion.
