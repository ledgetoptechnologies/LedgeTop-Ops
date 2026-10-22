# Windows package construction preview

`scripts/windows-package-preview.ps1` builds from a required exact local Git
commit, rather than a mutable UI working tree. It verifies the pinned helper,
root license and Microsoft packaging tool, uses SDK10.0.402, publishes the
compiled pilot channel, validates the MSIX, extracts it and compares every
payload file's path, byte length and SHA256. The PE channel inspector does not
execute application code. The app and helper are never launched by this script.

The declared build outputs and NuGet/CLI caches use a new local output directory.
This is not a guarantee that OS/tool incidental temporary files never appear
elsewhere. All six changed process environment settings are restored, including
the distinction between an absent value and an empty value.

Actual controlled run on October22,2026 exited0, including the independent outer
environment-equality check. Source was exact desktop1dacf5ba6f2d454f94b143171afa17ebec07aed3;
archiveSHA2569191cd4db1ccb45d3ff586af2f8dffa46a7a20eb4204a23ce2ae15f00b00c134.
The source has separately tested idle/delayed-close behavior, but its retained
old-person queue defect remains known. This run qualifies the construction tool,
not this older application revision for release. Claude's composite lifecycle
correction still requires exact-source acceptance and a fresh package build.

The successful preview contains406 files/202008999 bytes, including the pinned
cloudflared helper and its root license. Validated unsigned MSIX is83586270 bytes,
SHA256dc4e5bddccac0b383e178751824e889b47d461e98c0f636431a61e5dd78428ca.
Receipt is `windows-package-preview-2026-10-22.json`. Unique output directory and
all tool/input/source hashes are recorded there. Package byte identity is not
promised across builds: ZIP timestamps can differ even when the extracted
payload inventory matches exactly.

The first full rehearsal packed/extracted correctly but failed the outer
environment check: this runtime's .NET environment setter restored absent values
as empty strings. The script now explicitly removes previously absent values;
the subsequent full run passed. The earlier rehearsal is not an overall pass.

Required inputs are absolute existing local fixed-drive paths without reparse
ancestors: SourceRepository, ReviewedCommit, DotnetPath, MakeAppxPath, HelperPath
and HelperLicensePath. Use already qualified private tool caches documented in
the release plan; no global SDK, PATH or certificate change is required.

This preview uses a separate construction-only identity/publisher and technical
placeholder assets. It is not for installation/distribution. Source acceptance,
runtime tests, complete binary attribution, signing, clean-machine install/update,
live employee/authorized R2 delivery and Cloud Files hydration remain separate
gates. Nothing was signed, installed, registered, published or deployed.
