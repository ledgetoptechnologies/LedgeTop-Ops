# Go runtime notice package qualification

Actual source-pinned unsigned construction at
`51a083b639f37f6810848a365cdbbb36c943564f` completed2026-10-22.
It adds the ten retained Go1.27.3 root/vendor LICENSE and PATENTS files, plus
their provenance manifest, to the previously qualified module/.NET notice
package. No helper or downloaded source was executed. No install, signing,
trust, publication, production or NAS change occurred.

The same reviewed Git archive now includes only the additional Go notice
directory and its manifest from the pinned source commit. The offline collector
checks the exact qualified helper hash, canonical manifest SHA256 and every
original vendor file's length/SHA256 before creating its output directory.
Ten original vendor files total13780 bytes. Under
`Notices/Go-runtime-1.27.3/`, their bytes stay unchanged and `manifest.json`
records their immutable official Go source URLs/hashes. Only JSON manifest
line endings are canonicalized to LF, with SHA256
`7a30ba6b0edad3a8bd92d6c672bf365675cc9242eb4d63a4738280eb4bdcfdf4`.

Observed focused checks:

- Actual collector copied all ten vendor files and manifest successfully.
- A vendor LICENSE changed in a separate owned temporary source directory was
  rejected before output; the temporary payload remained empty.
- A changed provenance manifest was rejected by its pinned digest.
- A different helper hash was refused before input processing.
- A rerun against an existing Go notice output directory was refused, retaining
  the prior files. No existing package/artifact was overwritten.

The actual full construction then passed validated MakeAppx pack/unpack and
complete path/length/SHA256 comparison, including the new eleven files. Result:

| Observation | Result |
| --- | --- |
| Payload files | 522 |
| Payload bytes | 202547524 |
| Unsigned MSIX bytes | 83809359 |
| MSIX SHA256 | `b7c01c87461471def1a432b2554c2b734aeb9042a4a5e47e5fd00ab4b7b7e472` |
| Payload inventory SHA256 | `802cbbe67714cc87e3c3e817312f8881bf536ad04ac153b81945d03bb467104a` |
| Application DLL SHA256 | `f4b108999b1a015623cc7396d47d12b3c45c7727e00b0a9abcd66bcf0dd99aca` |

The DLL hash remains the same as the prior notice-only candidate. This is a
construction/notice-inclusion result, not a new claim of source acceptance,
human login, runtime install/update behavior or clean-machine qualification.
Exact source/tool/archive/artifact evidence is in the adjacent JSON receipt.
Documentation-only changes followed; no additional full pack was run for them.

Go notice collection/inclusion closes that specific omission. Complete
attribution remains false: source-embedded/per-subcomponent notice review,
native static/dynamic CGO provenance and the vendor's modified main-source
worktree remain unresolved. The public recipe/PE import observations from the
earlier provenance research do not clear those issues. Stable channel setup,
trusted signing, App Installer publication and clean-machine lifecycle tests
remain separate work.
