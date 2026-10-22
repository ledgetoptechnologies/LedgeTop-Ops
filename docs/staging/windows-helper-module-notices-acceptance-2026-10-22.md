# Linked Go module notice collection evidence

Actual bounded collection completed on2026-10-22 using
`scripts/windows-helper-module-notices.ps1` and the exact qualified helper
inventory. No helper, downloaded module source or upstream build script was
executed. No signing, upload, product runtime, authentication, NAS or registry
change occurred.

Observed results:

- All66 immutable module/version ZIPs downloaded from official
  `proxy.golang.org`. Module path case escaping follows the Go proxy protocol.
  The three linked replacements were resolved before retrieval.
- The Go content checksum of every archive matched the exact expected `h1:`
  value from the qualified helper's linked build metadata. The collector hashes
  every entry's content in ordinal entry-name order and then hashes the Go
  summary, rather than comparing compressed ZIP bytes to a Go checksum.
- Retained99 actual upstream notice/copyright/license/author files, mapped to
  each original module entry and its verified archive in the bundle manifest.
  Every module contributed at least one selected notice. Compressed source ZIPs
  stay in an owned local cache; only notice text and provenance enter source.
- A complete second run using that cache produced byte-identical manifest and
  all99 vendor notice files. The retained bundle comprises435468 bytes before
  its README and local `.gitattributes` are added. This identifies this observed
  input/run, not cross-tool or cross-line-ending byte reproducibility.
- Negative qualification changed a vendor notice inside a copied first-module
  ZIP in a separate owned cache. Collection failed with the expected module
  content-hash mismatch before any vendor notice output was written.
- A changed module/version in a copied inventory failed the pinned normalized
  inventory digest before collection. Existing output folders are refused;
  vendor notices are never replaced by a rerun.

The first negative-test setup attempted a nonexistent root `LICENSE` entry in
the first module and therefore did not modify that ZIP. It was not counted as a
negative-test pass. The corrected test used the original notice entry from the
bundle manifest, confirmed it existed, modified that entry, and observed the
expected rejection and empty output directory.

The source bundle's README and manifest retain the scope limits. Filename
selection does not identify all source-embedded/per-subcomponent notices or
prove which subpackages were linked; extra test/subpackage notices are retained
conservatively. This does not close Go toolchain/runtime, native CGO/Windows or
modified main-module source provenance. Complete attribution stays false and
the bundle is not yet injected into published/installed product artifacts.

The underlying algorithms and service are described by the primary sources:
[Go module proxy services](https://proxy.golang.org/),
[Go module ZIP specification](https://go.dev/ref/mod#module-zip-files),
[Go checksum implementation](https://github.com/golang/mod/blob/master/sumdb/dirhash/hash.go).
