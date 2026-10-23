# Windows redistribution notice repair

Bounded source/package work on October22. No install, signing, trust change,
authentication, upload, deployment or NAS access occurred.

## Actual omissions and changes

The prior retained406-file package payload contained the cloudflared root
license but no .NET licenses/notices. Its runtimeconfig and deps identify the
NETCore and WindowsDesktop10.0.13 x64 runtime packs. The two exact nupkgs were
independently verified with SDK10.0.402's `dotnet nuget verify --all`; both
Microsoft author and NuGet repository signatures passed. Their SHA256 values
and the selected ZIP entry hashes are pinned in the notice collector and the
new package receipt. It copies the vendor bytes, rather than synthesizing a
short license summary.

WindowsDesktop's nupkg contains its license but lacks separate third-party
notices. The collector additionally retains Microsoft's unmodified WPF and
Windows Forms notice files from the exact `dotnet/dotnet` commit recorded in
that nupkg's nuspec. Local `.gitattributes` preserves those source bytes. Their
README explains the conservative inclusion scope: the actual WPF layout ships
Presentation and shared drawing binaries, not `System.Windows.Forms.dll`.

## Observed qualification

1. Actual standalone collector copied the three nupkg notices from the existing
   signed packages; repeating against the same output was refused before an
   existing notice was replaced. A runtimeconfig changed to10.0.14 was refused.
2. Full unsigned clean-archive construction at
   `04d3ba6e97394df4ae61ec119ef08252941b4a90` exited0. All five notices survived
   validated MakeAppx pack/unpack and the complete path/length/SHA256 comparison.
   Receipt: `windows-runtime-notices-package-2026-10-22.json`. Payload411 files,
   202096041 bytes; package83607518 bytes; package SHA256
   `fcfee64221da4e93007b59f9970f123df31f709f8f15abfaccbfc3078dd272f4`.
   Later edits clarify documentation and vendor whitespace handling only.
3. `windows-helper-buildinfo.mjs` inspected the exact already qualified helper
   bytes without executing them. It found66 linked module entries and three
   replacements, Go1.27.3, `CGO_ENABLED=1`, the expected VCS revision and
   `vcs.modified=true`. The helper hash is checked before parsing; unreviewed
   bytes were rejected. The linked inventory is retained beside this file.

The module reader is deliberately specific to that known hash/Go inline
build-info layout. It is not a general PE validator or an SBOM certification.
Its framing interpretation was checked against the
[Go buildinfo implementation](https://github.com/golang/go/blob/master/src/debug/buildinfo/buildinfo.go).

## Remaining publication work

- Collect actual license/notice texts for the66 linked Go modules, honoring the
  replacement versions/forks instead of the unreplaced go.mod list. Include Go
  runtime/toolchain notices and establish native CGO component provenance. The
  official helper's modified-source marker prevents treating its public commit
  alone as a complete build-source inventory. Do not infer license permission
  merely because a repository or release asset is public.
- Configure a reviewed stable profile only after live production origin and
  human-auth acceptance. Reserve durable distinct pilot/stable identities and
  choose the trusted publisher/signing mechanism; construction publisher and
  gray assets are not distribution identities/artwork.
- Implement a real fixed-HTTPS App Installer descriptor after those choices;
  direct `.appinstaller` download links, forward-only version updates, launch
  plus background checks, and no arbitrary downgrade. The current repository
  contains no production descriptor or signed installer.
- Qualify clean Windows11 install, partial transfer during update, offline
  update, forward-version rollback/state compatibility, identity switching and
  revoked access. Uninstall must preserve completed downloads and avoid cleanup
  of arbitrary selected folders. Cloud Files registration/hydration/offline
  pinning remains separate, not implied by successful MSIX construction.

The receipt correctly keeps complete attribution, signature, install, clean
machine and live-transfer fields false. This patch repairs concrete missing
redistribution material; it does not clear the remaining release gates.
