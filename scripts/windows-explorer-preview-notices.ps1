param(
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$NugetPackagesDirectory,
  [string]$SourceNoticeDirectory = (Join-Path $PSScriptRoot '../apps/windows-download/Packaging/Notices'),
  [switch]$VerifyOnly
)

# Offline attribution for exactly the two Windows SDK .NET assemblies added to the Explorer preview.
# Compose with windows-package-runtime-notices.ps1 for the separate .NET/WPF runtime notices.
$ErrorActionPreference = 'Stop'
function HashBytes([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function LocalDirectory([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'Use an absolute local directory.' }
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Directory]::Exists($full) -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use an existing local fixed-drive directory.' }
  for ($part=$full; $null -ne $part; $part=[IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse directories are not notice inputs.' }
  }
  $full
}
function PlainFile([string]$Path) {
  $null = LocalDirectory ([IO.Path]::GetDirectoryName($Path))
  if (-not [IO.File]::Exists($Path) -or ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Expected a plain local file.' }
}

$payload = LocalDirectory $PayloadDirectory
$packages = LocalDirectory $NugetPackagesDirectory
$sourceNotices = LocalDirectory $SourceNoticeDirectory
$packageVersion = '10.0.22621.57'
$packageId = 'microsoft.windows.sdk.net.ref'
$packageSha = 'd3d007095a52fcb3dfaf0d091a9912965d9f5e41e223172ed9738436fe2d68b2'
$packagePath = Join-Path $packages "$packageId/$packageVersion/$packageId.$packageVersion.nupkg"
PlainFile $packagePath
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $packageSha) { throw 'Windows SDK source package hash differs.' }

$depsPath = Join-Path $payload 'LedgeTop.Files.deps.json'; PlainFile $depsPath
$deps = Get-Content -LiteralPath $depsPath -Raw | ConvertFrom-Json
$sdkLibraries = @($deps.libraries.PSObject.Properties.Name | Where-Object { $_.StartsWith('runtimepack.Microsoft.Windows.SDK.NET.Ref/', [StringComparison]::Ordinal) })
if ($sdkLibraries.Count -ne 1 -or $sdkLibraries[0] -cne "runtimepack.Microsoft.Windows.SDK.NET.Ref/$packageVersion") { throw 'Windows SDK runtime dependency differs.' }

$binaries = @(
  @{name='Microsoft.Windows.SDK.NET.dll';entry='lib/net8.0/Microsoft.Windows.SDK.NET.dll';bytes=26086944;sha256='2891aee0893bc66ca2d9d781f1ea84017bbb7d80700e31fb6e8c0bc48490fa09';sourceVersion='10.0.22621.55+7e1ba99b2f0c1ea5311dcb3acfe20a75335efd6e'},
  @{name='WinRT.Runtime.dll';entry='lib/net8.0/WinRT.Runtime.dll';bytes=528944;sha256='bcf3a14e8712a90837fc5c0d8c8a24696af2bd7f74e9767597ec81ededfb23db';sourceVersion='2.2.0.48161+8649ee3eeb2445ca2a36d80d878ef60b96a6c65d'}
)
$zip = [IO.Compression.ZipFile]::OpenRead($packagePath)
try {
  foreach ($binary in $binaries) {
    $entries = @($zip.Entries | Where-Object { $_.FullName -ceq $binary.entry })
    if ($entries.Count -ne 1 -or $entries[0].Length -ne $binary.bytes) { throw 'SDK assembly is missing, duplicated or has an unexpected length.' }
    $stream = $entries[0].Open()
    try { $entrySha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
    finally { $stream.Dispose() }
    if ($entrySha -cne $binary.sha256) { throw 'SDK source assembly hash differs.' }
    $path = Join-Path $payload $binary.name; PlainFile $path
    if ((Get-Item -LiteralPath $path).Length -ne $binary.bytes -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $binary.sha256 -or
        [Diagnostics.FileVersionInfo]::GetVersionInfo($path).ProductVersion -cne $binary.sourceVersion) { throw 'Published SDK assembly differs from its pinned source.' }
  }
} finally { $zip.Dispose() }

$sources = @(
  @{name='LICENSE.Windows.SDK.rtf';sha256='dd07eb178e00c6bba4148457fc00ff77cd4887eb521d504186fe59c9ec8bbe62';url='https://download.microsoft.com/download/0/F/F/0FF2B061-47DD-4F55-89B6-FD1D8C44F14D/sdk_license.rtf';scope='Windows SDK package license, linked by pinned nuspec https://aka.ms/WinSDKLicenseURL'},
  @{name='LICENSE.CsWinRT.txt';sha256='c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383';url='https://raw.githubusercontent.com/microsoft/CsWinRT/8649ee3eeb2445ca2a36d80d878ef60b96a6c65d/nuget/LICENSE';scope='Additional C#/WinRT MIT source license at WinRT.Runtime informational-version commit'},
  @{name='THIRD-PARTY-NOTICES.CsWinRT.txt';sha256='5c73ec182c994adc9d90cc576c3188a7f55df4c129a7dfb923e1ce4d91ed154d';url='https://raw.githubusercontent.com/microsoft/CsWinRT/8649ee3eeb2445ca2a36d80d878ef60b96a6c65d/nuget/NOTICE.txt';scope='C#/WinRT package source third-party notices at the same commit'}
)
$pending = @()
foreach ($source in $sources) {
  $path = Join-Path $sourceNotices $source.name; PlainFile $path
  $bytes = [IO.File]::ReadAllBytes($path)
  if ($bytes.Length -gt 1MB -or (HashBytes $bytes) -cne $source.sha256) { throw 'SDK component source notice differs.' }
  $pending += @{name=$source.name;bytes=$bytes;sha256=$source.sha256;url=$source.url;scope=$source.scope}
}

# Validate every input and every existing output before writing. Existing matching notices are idempotent;
# an unexpected file is never overwritten, and VerifyOnly performs no writes.
$noticeDirectory = Join-Path $payload 'Notices'
if ([IO.Directory]::Exists($noticeDirectory)) { $null = LocalDirectory $noticeDirectory }
elseif (Test-Path -LiteralPath $noticeDirectory) { throw 'Notices output is not a directory.' }
foreach ($notice in $pending) {
  $path = Join-Path $noticeDirectory $notice.name
  if (Test-Path -LiteralPath $path) {
    PlainFile $path
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $notice.sha256) { throw 'Refusing to replace an existing notice with different bytes.' }
  } elseif ($VerifyOnly) { throw 'Expected SDK notice is not present.' }
}
if (-not $VerifyOnly) {
  if (-not [IO.Directory]::Exists($noticeDirectory)) { $null = [IO.Directory]::CreateDirectory($noticeDirectory) }
  $null = LocalDirectory $noticeDirectory
  foreach ($notice in $pending) {
    $path = Join-Path $noticeDirectory $notice.name
    if ([IO.File]::Exists($path)) { continue }
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($notice.bytes) } finally { $stream.Dispose() }
  }
}
[pscustomobject]@{
  schemaVersion=1;scope='Windows SDK .NET preview assemblies only';sdkAssemblyNoticesIncluded=$true;completeThirdPartyAttribution=$false
  packageId=$packageId;packageVersion=$packageVersion;packageSha256=$packageSha
  redistributionEvidenceUrl='https://learn.microsoft.com/en-us/legal/windows-sdk/redist#Microsoft.Windows.SDK.NET.Ref'
  binaries=@($binaries | ForEach-Object { [pscustomobject]@{path=$_.name;bytes=$_.bytes;sha256=$_.sha256;packageEntry=$_.entry;informationalVersion=$_.sourceVersion} })
  notices=@($pending | ForEach-Object { [pscustomobject]@{path="Notices/$($_.name)";bytes=$_.bytes.Length;sha256=$_.sha256;sourceUrl=$_.url;scope=$_.scope} })
} | ConvertTo-Json -Depth 6
