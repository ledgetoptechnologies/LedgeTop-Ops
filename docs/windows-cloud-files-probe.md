# Windows Cloud Files capability probe

This first native slice checks Cloud Files API availability and reads placeholder
state metadata for one explicitly selected existing local file. It does **not**
register a sync root, create placeholders, pin/dehydrate/hydrate content, install
anything, integrate Explorer, or implement online-only/offline availability.

`CloudFilesProbe` in the download Core exposes explicit `Supported`,
`Unsupported`, and `Error` results. A successful platform probe means the query
API is available, not that the application has a working sync provider or that
every Cloud Files feature is available. Platform integration/build numbers are
returned unchanged; they are not treated as Windows OS build numbers.

The native boundary calls `CfGetPlatformInfo` using the documented three-DWORD
`CF_PLATFORM_INFO` structure and HRESULT success contract. Exact-file inspection
uses attribute/tag metadata from `FindFirstFileW`, then
`CfGetPlaceholderStateFromAttributeTag`. The search handle is always disposed;
there is no `FindNextFile`, recursive enumeration, file data stream, or hydration
API. Native DLL imports resolve only from System32.

The accepted path subset excludes UNC/device paths, wildcards, ADS, dot segments,
DOS device basenames, directories, and legacy-length overflow. The native lookup
also conservatively requires a fixed drive with a physical `HarddiskVolume<N>`
mapping; mapped, SUBST and unrecognized drives are unsupported. Each ancestor's
attributes are checked and reparse ancestors are refused. This deliberately
excludes files beneath cloud reparse directories as well as junctions. These
metadata checks are not an adversarial path-race sandbox: another process could
change filesystem mappings after a check. No files from user datasets, NAS or
network drives were used in qualification.

Unknown/invalid placeholder bits and inconsistent state combinations are errors.
`None` means the inspected entry is not a Cloud Files placeholder; partial flags
alone do not establish a pin policy or a complete offline copy. No filename,
native exception text, credentials, or data bytes are included in probe results.

## Verification

The three new test groups are registered in the existing `Tests/Program.cs`, so
the existing Windows test command also executes them:

```powershell
dotnet run --project apps/windows-download/Tests/WindowsDownload.Tests.csproj
```

Use the repository-pinned SDK 10.0.402. The injectable native seam covers success,
unsupported HRESULT/library/platform outcomes, malformed results, invalid paths,
unknown states, and metadata failures without loading native libraries.

Actual Windows qualification on 2026-10-22 passed **66/66 groups**. The native
platform returned build **26100**, revision **9278**, integration **1576**. An
owned temporary ordinary file returned state **0** (not a placeholder), with
unchanged content digest, attributes, and last-write time. Its file and directory
were removed afterward. A Windows native smoke fails if platform support is
absent; on another OS the test explicitly reports a native acceptance skip and
verifies only the unsupported outcome. Real placeholder, registration, Explorer,
pin, hydration and online-only/offline behavior remain unqualified.

Primary declarations: [CfGetPlatformInfo](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfgetplatforminfo),
[CF_PLATFORM_INFO](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_platform_info),
[CfGetPlaceholderStateFromAttributeTag](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfgetplaceholderstatefromattributetag),
[placeholder flags](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ne-cfapi-cf_placeholder_state),
[FindFirstFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfilew),
[WIN32_FIND_DATAW](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-win32_find_dataw),
[GetDriveTypeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew),
[QueryDosDeviceW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-querydosdevicew),
and [GetFileAttributesW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileattributesw).
