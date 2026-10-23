param(
  [Parameter(Mandatory)][string]$SourceDirectory,
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$HelperSha256
)

# Offline copy of exact reviewed Go1.27.3 notice bytes for the qualified helper.
# No toolchain/helper execution, download, installation or completeness claim.
$ErrorActionPreference = 'Stop'
function LocalDirectory([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'Use an absolute local directory.' }
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Directory]::Exists($full) -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use an existing local fixed-drive directory.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse directories are not notice inputs.' }
  }
  $full
}
if ($HelperSha256 -cne '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2') { throw 'Go notice bundle is only qualified for the reviewed helper hash.' }
$source = LocalDirectory $SourceDirectory
$payload = LocalDirectory $PayloadDirectory
$manifestPath = Join-Path $source 'go-runtime-notices.json'
if (([IO.File]::GetAttributes($manifestPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse notice manifest.' }
$manifestText = [IO.File]::ReadAllText($manifestPath).Replace("`r`n", "`n")
$manifestBytes = [Text.Encoding]::UTF8.GetBytes($manifestText)
$manifestSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant()
if ($manifestSha256 -cne '7a30ba6b0edad3a8bd92d6c672bf365675cc9242eb4d63a4738280eb4bdcfdf4') { throw 'Go notice provenance manifest differs.' }
$notices = @($manifestText | ConvertFrom-Json)
if ($notices.Count -ne 10) { throw 'Expected ten reviewed Go notice files.' }
$pending = @()
foreach ($notice in $notices) {
  if ($notice.outputPath -cnotmatch '\Ago-runtime-notices/[A-Za-z0-9_.-]+\.txt\z') { throw 'Unexpected Go notice path.' }
  $inputPath = Join-Path $source $notice.outputPath
  $null = LocalDirectory ([IO.Path]::GetDirectoryName($inputPath))
  if (([IO.File]::GetAttributes($inputPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse vendor notice.' }
  $bytes = [IO.File]::ReadAllBytes($inputPath)
  $sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  if ($bytes.Length -ne $notice.bytes -or $sha256 -cne $notice.sha256) { throw 'Go vendor notice bytes differ.' }
  $pending += @{name=[IO.Path]::GetFileName($notice.outputPath);bytes=$bytes}
}
$noticeParent = Join-Path $payload 'Notices'
if (-not [IO.Directory]::Exists($noticeParent)) { $null = [IO.Directory]::CreateDirectory($noticeParent) }
$null = LocalDirectory $noticeParent
$destination = Join-Path $noticeParent 'Go-runtime-1.27.3'
if (Test-Path -LiteralPath $destination) { throw 'Refusing to replace existing Go notice output.' }
$null = [IO.Directory]::CreateDirectory($destination)
foreach ($notice in $pending) {
  $stream = [IO.File]::Open((Join-Path $destination $notice.name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($notice.bytes) } finally { $stream.Dispose() }
}
[IO.File]::WriteAllBytes((Join-Path $destination 'manifest.json'), $manifestBytes)
[pscustomobject]@{schemaVersion=1;helperSha256=$HelperSha256;goVersion='1.27.3';sourceCommit='2aae1000ea1d4b28923b96db28acf4e3b99d6aff';noticeFiles=10;manifestSha256=$manifestSha256;completeThirdPartyAttribution=$false} | ConvertTo-Json
