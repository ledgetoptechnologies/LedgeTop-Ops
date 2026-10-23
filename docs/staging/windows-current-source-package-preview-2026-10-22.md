# Current Windows source package construction

The unsigned x64 preview was rebuilt from reviewed app source
`6a87b077c575072c74aafb5c3f56f8998d9e582e`, including the portal metadata
deadline fix. This supersedes the older `51a083b6` construction artifact for
current-code packaging evidence. The earlier signing capability rehearsal still
describes its older input; it was not repeated or relabeled.

- App tree: `ad7fb749b1e7a05697718ca39de1092a73034575`.
- SDK `10.0.402`, self-contained `win-x64`, compiled pilot channel.
- Validated MakeAppx pack and exact unpacked inventory: 522 payload files.
- Package: 83,832,380 bytes, SHA-256
  `9046975976a9f13a127995e9326a7b8a7e92cd237acafbbe19d035d908de63ef`.
- App assembly SHA-256:
  `f4b108999b1a015623cc7396d47d12b3c45c7727e00b0a9abcd66bcf0dd99aca`.
- Pinned helper, Microsoft tool signatures, compiled channel before/after pack,
  all per-file hashes and absence of an Appx signature were checked.
- The identity/hash-bound App Installer preview passed its positive assertions
  and 20 refusal cases against this new package. Descriptor SHA-256:
  `8f419370ec5548ba01702d7607aaddd7bf7146acc3e7d3a97d7c7ab1afd5414b`.

The original construction receipt and package remain together in the owned local
package-preview directory. The public JSON preserves the receipt data and hash
without the PC output path. It also records the actual descriptor test result.
Descriptors use reserved `.invalid` origins and an `.xml` suffix; they do not
create a working update channel.

The constructor does not run application acceptance, so its
`sourceAcceptanceVerified` and `runtimeTestsExecuted` remain false. The separate
90/90 Core source acceptance is recorded in the review matrix; it is not an
installed-package test. No certificate was installed, signing attempted, package
registered, authenticated transfer performed or artifact published by this run.

Trusted signing, complete third-party attribution/provenance, final artwork,
clean-machine installation/update/rollback/uninstall, real session/file acceptance
and Windows update behavior remain release gates. The package is an unsigned
construction preview with the temporary publisher, not a downloadable release.
