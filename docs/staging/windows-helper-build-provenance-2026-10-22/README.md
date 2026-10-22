# Qualified Windows helper build provenance

Read-only research for the exact already-qualified cloudflared2026.10.3 Windows
amd64 binary, performed2026-10-22. No downloaded source/helper was executed, no
maintainer was contacted, and no product runtime, package, signing, publication,
trust, installer, registry, credentials or NAS changed in this research step.

## What the primary evidence establishes

- The fresh GitHub release API still advertises the exact55329336-byte asset
  and SHA256 `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`.
  Release metadata records `immutable=false`; retain the digest, not just tag.
- Fresh Windows Authenticode verification of those local bytes is Valid, signed
  by Cloudflare, Inc., with a DigiCert timestamp signer. See `authenticode.json`.
  This verifies the vendor signature, not a complete build-input inventory.
- Pinned public source at `de6376c5af4a67cbc65258682e5a01781827643d`
  explicitly configures `GO_VERSION=1.27.3`, expands `WIN_GO_VERSION=go1.27.3`,
  and invokes a Windows wrapper that downloads the Go Windows amd64 ZIP from
  `go.dev`. The amd64 build script sets `CGO_ENABLED=1`, runs `make cloudflared`,
  signs with AzureSignTool and copies to the expected release asset name.
  Dependency download is followed by a `go.mod`/`go.sum` diff check.
- Build recipes are retained as unexecuted `.source.txt` reference files with
  original pinned URLs, lengths and SHA256 values in `build-recipes.json`. They
  are public source, not instructions for this agent to run.
- The exact binary's embedded Go version/revision/CGO fields match this declared
  recipe. Its `vcs.modified=true` field records a modified build worktree. It
  does not establish what changed or imply corruption/compromise.
- The Go `go1.27.3` tag resolves to official source commit
  `2aae1000ea1d4b28923b96db28acf4e3b99d6aff`. Ten unmodified root/vendor LICENSE
  and PATENTS files are collected from that immutable commit, including the
  vendored runtime crypto/net/sys/text material. `go-runtime-notices.json`
  records URLs, exact bytes and SHA256 values; retained texts were rehashed.
  These are version-appropriate conservative notices, not proof that every
  corresponding source subpackage is linked or the vendor used unmodified Go.

## Attestations and native boundary

The GitHub exact-digest attestation-list request returned404. The standard
`gh attestation verify` command for this exact artifact and repository likewise
returned404 for SLSA provenance v1. No accessible attestation was obtained or
verified. This is a failed provenance lookup, not proof that none exists in
other systems/access scopes; `attestation-observation.json` retains that limit.

Actual read-only PE inspection finds AMD64/PE32+, KERNEL32 and eight UCRT API-set
import descriptors, with no delay-import directory. Exact DLL contracts and
symbols are retained in `pe-imports.json`. Microsoft's managed PEReader
independently confirmed architecture/format and import/delay directory headers.
The offline inspection script rejects any helper hash other than this qualified
artifact and never loads it. Microsoft documents the
[PE format](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).

API-set contracts are loader-resolved OS interfaces, not necessarily DLL files
to bundle. Microsoft documents UCRT as a Windows10-and-later OS component, which
fits this app's Windows11 target. No separate UCRT DLL was collected or added to
the package. This contextualizes those imports; it does **not** prove there are
no statically linked native libraries or later dynamic loads.
[Windows API sets](https://learn.microsoft.com/en-us/windows/win32/apiindex/windows-apisets),
[Microsoft UCRT deployment](https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment?view=msvc-170).

The Windows job is assigned only the `canary-windows-x86` runner tag in public
source. The recipe does not pin a Windows runner image, C compiler executable,
compiler version, imported/static runtime provenance or actual invocation log.
The Linux CI image's `build-essential` package list is **not** evidence about
the Windows compiler. The wrapper names an official Go ZIP URL but does not
record that downloaded toolchain archive's digest in this public recipe.
Consequently native-CGO/build-source completeness cannot be established from
the available evidence, even after collecting the Go notice texts.

## Remaining concrete decision

Keep the signed vendor helper as the local/pilot candidate and retain these
facts and notices. Before claiming complete redistribution/build provenance for
public binary distribution, either obtain reviewable vendor build-input/native
component evidence for this digest, or qualify a separately pinned/reviewed
source/toolchain build with its own helper hash, notices, tests and trusted
distribution-signing plan. The latter would be a new artifact qualification;
this research does not substitute it automatically or change the installed
helper pin. No maintainer outreach or signing purchase is authorized here.

`completeThirdPartyAttribution` and native build provenance remain unproved.
The ten Go notices are source evidence only in this step; the latest verified
unsigned construction package remains the previous511-file module-notice build.
