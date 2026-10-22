param(
  [Parameter(Mandatory)][string]$SourceRepository,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [Parameter(Mandatory)][string]$DotnetPath,
  [Parameter(Mandatory)][string]$MakeAppxPath,
  [Parameter(Mandatory)][string]$HelperPath,
  [Parameter(Mandatory)][string]$HelperLicensePath
)

# LOCAL, UNSIGNED construction test for an already reviewed source commit.
# No installation, signing, publishing, provider registration or authentication.
# A passing receipt does not approve this source or establish live delivery.
$ErrorActionPreference = 'Stop'
$helperSha = '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
$licenseSha = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd'
$makeAppxSha = '98ddf5a4fdb38a1d32c2ca7b350a2012ed430d277baa1bf03ac91ef82365f1d3'
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function LocalPath([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'Use an absolute local path.' }
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use a local fixed drive.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are not package inputs.' }
  }
  $full
}
function SignedBy([string]$Path, [string]$Organization) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate.Subject.Contains($Organization)) { throw 'Package tool signature differs.' }
}
$SourceRepository = LocalPath $SourceRepository
$DotnetPath = LocalPath $DotnetPath
$MakeAppxPath = LocalPath $MakeAppxPath
$HelperPath = LocalPath $HelperPath
$HelperLicensePath = LocalPath $HelperLicensePath
if ((Hash $MakeAppxPath) -ne $makeAppxSha -or (Hash $HelperPath) -ne $helperSha -or (Hash $HelperLicensePath) -ne $licenseSha) { throw 'Pinned package input differs.' }
SignedBy $DotnetPath 'O=Microsoft Corporation'
SignedBy $MakeAppxPath 'O=Microsoft Corporation'
SignedBy $HelperPath 'O="Cloudflare, Inc."'
$commitType = & git -C $SourceRepository cat-file -t $ReviewedCommit
if ($LASTEXITCODE -ne 0 -or $commitType -cne 'commit') { throw 'Reviewed source commit is unavailable.' }
$tree = & git -C $SourceRepository rev-parse "${ReviewedCommit}:apps/windows-download"
if ($LASTEXITCODE -ne 0) { throw 'Reviewed Windows source tree is unavailable.' }

$localData = LocalPath ([Environment]::GetFolderPath('LocalApplicationData'))
$parent = Join-Path $localData 'LedgeTopFilesPackagePreviews'
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
$parent = LocalPath $parent
$root = Join-Path $parent ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$environmentNames = @('NUGET_PACKAGES','NUGET_HTTP_CACHE_PATH','DOTNET_CLI_HOME','DOTNET_CLI_TELEMETRY_OPTOUT','DOTNET_SKIP_FIRST_TIME_EXPERIENCE','DOTNET_GENERATE_ASPNET_CERTIFICATE')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
  $env:NUGET_PACKAGES = Join-Path $root 'nuget-packages'
  $env:NUGET_HTTP_CACHE_PATH = Join-Path $root 'nuget-http-cache'
  $env:DOTNET_CLI_HOME = Join-Path $root 'dotnet-home'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
  $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
  $sdk = & $DotnetPath --version
  if ($LASTEXITCODE -ne 0 -or $sdk -cne '10.0.402') { throw 'The reviewed SDK10.0.402 is required.' }
$archive = Join-Path $root 'source.zip'
& git -C $SourceRepository archive --format=zip "--output=$archive" $ReviewedCommit -- apps/windows-download
if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
$source = Join-Path $root 'source'
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $source)
$payload = Join-Path $root 'payload'
$publishLog = Join-Path $root 'publish.log'
Push-Location -LiteralPath (Join-Path $source 'apps/windows-download')
try {
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
  $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
  & $DotnetPath publish App/WindowsDownload.App.csproj -c Release -r win-x64 --self-contained true `
    --source https://api.nuget.org/v3/index.json --artifacts-path (Join-Path $root 'artifacts') -o $payload `
    -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false `
    -p:LedgeTopPackage=true -p:LedgeTopReleaseChannel=pilot *> $publishLog
  if ($LASTEXITCODE -ne 0) { throw 'Pilot publish failed; inspect the owned publish.log.' }
} finally { Pop-Location }
$checker = Join-Path $PSScriptRoot 'windows-package-channel-check.ps1'
$channel = & $checker -AssemblyPath (Join-Path $payload 'LedgeTop.Files.dll') -ExpectedChannel pilot | ConvertFrom-Json
New-Item -ItemType Directory -Path (Join-Path $payload 'helper'),(Join-Path $payload 'Notices'),(Join-Path $payload 'Assets') | Out-Null
$runtimeNotices = & (Join-Path $PSScriptRoot 'windows-package-runtime-notices.ps1') -PayloadDirectory $payload -NugetPackagesDirectory $env:NUGET_PACKAGES -SourceNoticeDirectory (Join-Path $source 'apps/windows-download/Packaging/Notices') | ConvertFrom-Json
Copy-Item -LiteralPath $HelperPath -Destination (Join-Path $payload 'helper/cloudflared.exe')
Copy-Item -LiteralPath $HelperLicensePath -Destination (Join-Path $payload 'Notices/LICENSE.cloudflared.txt')
if ((Hash (Join-Path $payload 'helper/cloudflared.exe')) -ne $helperSha -or (Hash (Join-Path $payload 'Notices/LICENSE.cloudflared.txt')) -ne $licenseSha) { throw 'Copied package input differs.' }
Add-Type -AssemblyName System.Drawing
foreach ($size in @(44,150)) {
  $bitmap = [Drawing.Bitmap]::new($size,$size)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.Clear([Drawing.Color]::DimGray); $bitmap.Save((Join-Path $payload "Assets/Preview$size.png"), [Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
}
@'
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap uap10 rescap">
 <Identity Name="LedgeTop.Files.PilotBuildPreview" Publisher="CN=LedgeTop Build Preview" Version="0.0.0.1" ProcessorArchitecture="x64"/>
 <Properties><DisplayName>Ledge Top Files Build Preview</DisplayName><PublisherDisplayName>Ledge Top</PublisherDisplayName><Description>Unsigned local construction test</Description><Logo>Assets\Preview150.png</Logo></Properties>
 <Resources><Resource Language="en-us"/></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.22000.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
 <Applications><Application Id="Files" Executable="LedgeTop.Files.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL"><uap:VisualElements DisplayName="Ledge Top Files Build Preview" Description="Unsigned local construction test" Square150x150Logo="Assets\Preview150.png" Square44x44Logo="Assets\Preview44.png" BackgroundColor="transparent"/></Application></Applications>
 <Capabilities><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
'@ | Set-Content -LiteralPath (Join-Path $payload 'AppxManifest.xml') -Encoding utf8
'UNSIGNED LOCAL BUILD PREVIEW. Not for installation or distribution. No live delivery, signing, clean-machine install/update or complete dependency attribution is qualified.' | Set-Content -LiteralPath (Join-Path $payload 'BUILD-PREVIEW.txt') -Encoding utf8
$inventory = @(Get-ChildItem -LiteralPath $payload -File -Recurse | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse file in payload.' }
  [pscustomobject]@{path=[IO.Path]::GetRelativePath($payload,$_.FullName).Replace([IO.Path]::DirectorySeparatorChar,[char]'/');bytes=$_.Length;sha256=(Hash $_.FullName)}
} | Sort-Object path)
$inventoryPath = Join-Path $root 'inventory.json'
$inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $inventoryPath -Encoding utf8
$package = Join-Path $root 'preview.msix'
# Validation stays on. No /nv, overwrite, registration or signing switch.
& $MakeAppxPath pack /d $payload /p $package *> (Join-Path $root 'pack.log')
if ($LASTEXITCODE -ne 0) { throw 'Validated pack failed; inspect owned pack.log.' }
$unpacked = Join-Path $root 'unpacked'
& $MakeAppxPath unpack /p $package /d $unpacked *> (Join-Path $root 'unpack.log')
if ($LASTEXITCODE -ne 0) { throw 'Unpack failed; inspect owned unpack.log.' }
foreach ($item in $inventory) {
  $actual = Join-Path $unpacked $item.path
  if ((Get-Item -LiteralPath $actual).Length -ne $item.bytes -or (Hash $actual) -ne $item.sha256) { throw 'Extracted payload differs.' }
}
$extra = @(Get-ChildItem -LiteralPath $unpacked -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($unpacked,$_.FullName).Replace([IO.Path]::DirectorySeparatorChar,[char]'/') } | Where-Object { $_ -notin $inventory.path -and $_ -notin @('AppxBlockMap.xml','[Content_Types].xml') })
if ($extra.Count -ne 0 -or (Test-Path -LiteralPath (Join-Path $unpacked 'AppxSignature.p7x'))) { throw 'Unexpected packaged file or signature.' }
$extractedChannel = & $checker -AssemblyPath (Join-Path $unpacked 'LedgeTop.Files.dll') -ExpectedChannel pilot | ConvertFrom-Json
if ($extractedChannel.assemblySha256 -cne $channel.assemblySha256) { throw 'Extracted application identity differs.' }
$receipt = [pscustomobject]@{
  schemaVersion=1;status='unsigned_local_preview_only';sourceCommit=$ReviewedCommit;sourceTree=$tree;sourceArchiveSha256=(Hash $archive)
  sdk=$sdk;rid='win-x64';selfContained=$true;channel='pilot';applicationSha256=$channel.assemblySha256
  scriptSha256=(Hash $PSCommandPath);channelCheckerSha256=(Hash $checker);makeAppxSha256=$makeAppxSha
  runtimeNoticeCollectorSha256=(Hash (Join-Path $PSScriptRoot 'windows-package-runtime-notices.ps1'))
  helperSha256=$helperSha;rootLicenseSha256=$licenseSha;completeThirdPartyAttribution=$false
  runtimeNotices=$runtimeNotices.notices
  payloadFiles=$inventory.Count;payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;inventorySha256=(Hash $inventoryPath)
  packageBytes=(Get-Item -LiteralPath $package).Length;packageSha256=(Hash $package);validatedPack=$true;unpackedInventoryExact=$true
  sourceAcceptanceVerified=$false;runtimeTestsExecuted=$false
  signed=$false;installed=$false;published=$false;liveTransferTested=$false;cleanMachineTested=$false;outputRoot=$root
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 4
} finally {
  foreach ($name in $environmentNames) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name,$previousEnvironment[$name],'Process') }
  }
}
