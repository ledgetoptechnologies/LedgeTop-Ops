# Qualified helper module notice bundle

Actual upstream notice texts collected on2026-10-22 for the qualified
cloudflared2026.10.3 Windows amd64 binary SHA256
`76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`.
This is reviewed source material for future packaging, not an assertion that
the application's complete redistribution requirements are satisfied.

All66 linked module archives were fetched from the official Google-operated
`proxy.golang.org` service at their exact versions. Every archive's Go `h1:`
content hash matched the hash embedded in the qualified binary. Three replaced
dependencies use their replacement paths/versions/checksums; the quic-go and CLI
forks' actual license texts are retained, not substitutes from upstream HEAD.
`manifest.json` maps each original module and replacement to its immutable
module ZIP URL, ZIP SHA256, verified Go content hash and each retained notice's
original module path, output path, byte length and SHA256. Downloaded code was
never executed, built, installed or extracted as executable source.

The bundle contains99 files selected by license/notice/copyright/author filenames
or license directories. Every module had at least one selected file. Preserve
their original bytes; filenames are opaque output identifiers and provenance is
in the manifest. Nested files are included conservatively, including files for
subpackages/tests that may not be linked. Finding one notice in every module
does not prove all required notices were found: source-embedded notices,
per-subcomponent obligations and actual linked subpackages still need review.

Reproduce into a **new empty local directory** with:

```powershell
./scripts/windows-helper-module-notices.ps1 `
  -InventoryPath <absolute-path-to-windows-helper-linked-modules-2026-10-22.json> `
  -CacheDirectory <owned-local-module-zip-cache> `
  -OutputDirectory <new-empty-local-output-directory>
```

The collector pins the normalized inventory text, applies replacements, verifies
all archive entry content before retaining any notice for that module and never
falls back to mutable branch content. It refuses an occupied output directory.
It implements the published
[Go directory hash algorithm](https://github.com/golang/mod/blob/master/sumdb/dirhash/hash.go)
against module ZIP contents, not a plain SHA256 of compressed bytes. The
[official Go module service](https://proxy.golang.org/) describes its mirror and
checksum service; this run matched the vendor binary's embedded hashes rather
than claiming an independent Go checksum-database client implementation.

Still outside this bundle: cloudflared's own root license (already retained in
the unsigned preview), Go runtime/toolchain notices, native CGO/linked Windows
component provenance, and any source modifications implied by
`vcs.modified=true`. No publisher/signing/install/update qualification, license
purchase, legal conclusion, binary publication or production change is implied.
`completeThirdPartyAttribution` remains false. The unsigned package preview
retains these99 notice texts and their provenance manifest conservatively for
the exact helper hash. Inclusion is useful attribution material; it does not
clear the remaining distribution requirements.
