# Offline MSIX signing capability rehearsal

This local construction probe did **not** produce a signed package. The actual
Microsoft SDK tool rejected external digest generation for AppX/MSIX. No installer
qualification, durable publisher identity, trusted signature, installation,
update, publication, or online/offline Cloud Files acceptance is implied.

## Inputs and command

The retained unsigned preview was exactly 83,809,359 bytes, SHA256
`b7c01c87461471def1a432b2554c2b734aeb9042a4a5e47e5fd00ab4b7b7e472`.
It has 524 ZIP entries, no AppxSignature.p7x, and construction identity
`LedgeTop.Files.PilotBuildPreview`, `CN=LedgeTop Build Preview`, `0.0.0.1`, x64.
Its older construction source is `51a083b639f37f6810848a365cdbbb36c943564f`,
not the current runtime candidate.

The cached Microsoft.Windows.SDK.BuildTools 10.0.28000.2705 x64 SignTool has
SHA256 `d6c04707c59a67fce9fa4bb5fe76c79445b60e1e326d8b500a2f2ba8707c590a`.
Its Authenticode signature was valid and attributed to Microsoft Corporation.
This check uses Windows' existing tool-signature validation; it is not an
isolated network-denial test.

Invoke the script with PowerShell Core 7.3 or later (`pwsh`), not Windows
PowerShell 5.1. The actual run used the existing cached PowerShell 7.6.5 runtime;
the script declares both minimum version and Core edition requirements. Confirm
`$PSVersionTable` in the chosen executable before invocation. No shell fallback
or global tool installation is performed.

`scripts/windows-offline-signing-rehearsal.ps1` verifies those exact inputs,
creates an RSA key and one-hour code-signing certificate using managed
CertificateRequest, exports **only the public CER**, and invokes:

```text
signtool sign /fd SHA256 /f <owned-temp>/public.cer /dg <owned-temp> <owned-temp>/preview.msix
```

The private key is never exported, passed to SignTool, or installed in a
certificate store. No trust-installation command, timestamp URL, package install,
or publication is used. SignTool's message `Done Adding Additional Store` refers
to its additional certificate-store operation; this receipt makes no claim that
the process never used an in-memory store. This is not a network packet capture.

## Actual result

SignTool exited **1**, HRESULT **0x80070032**, reporting:

```text
Decoupled digest operation is not supported for AppX file. Use /dlib and /dmdf instead.
```

There were no `.dig`, `.p7u`, or `.signed` artifacts. The key and certificate were
disposed, the unique temporary directory was removed, and the original package
SHA256 still matched. The reviewed script was rerun after adding an owned-copy
hash check, guarded recursive-cleanup target validation, and exclusive receipt
creation. The result was the same unsupported SDK operation. Its safe receipt is
`windows-offline-signing-rehearsal-2026-10-22.json` alongside this document (original
capture: `C:/Users/fstor/.codex/tmp/windows-offline-signing-rehearsal-20261022-reviewed.json`).
The script names its guarantee `persistentCertificateInstallationRequested`.
PowerShell syntax validation passed. An unreviewed input was rejected before
certificate creation. A successful harness exit records an expected SDK rejection;
it is not a successful signing outcome.

No `/di` was attempted without a supported digest, and there was no direct PFX
fallback. This result applies to the SDK's `/dg` route, not every signing approach
that keeps private keys outside the signing process. Microsoft's
[Artifact Signing integration](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)
documents a supported `/dlib` path. Using it requires publisher enrollment and
identity verification, authorized credentials, and a separately reviewed release
workflow. No enrollment, purchase or credential creation was performed. A future
local native callback rehearsal or disposable signing VM is also unqualified.
Durable publisher selection, trusted signing and clean-machine installation remain
gates.

References: [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool),
[MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview),
[PFX import key persistence](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-pfximportcertstore).
