param(
  [Parameter(Mandatory)][string]$SourceRepository,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [Parameter(Mandatory)][string]$DotnetPath,
  [Parameter(Mandatory)][string]$AppVersion,
  [Parameter(Mandatory)][string]$HelperPath,
  [Parameter(Mandatory)][string]$HelperLicensePath,
  [string]$OfflinePackageSourceDirectory
)

# Local unsigned connected-pilot payload construction only. Never installs, signs,
# publishes, authenticates, registers a provider, or qualifies live behavior.
$ErrorActionPreference = 'Stop'
$helperSha = '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
$licenseSha = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd'
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
if ($AppVersion -cnotmatch '\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z' -or @($AppVersion.Split('.') | Where-Object { [int]$_ -gt 65535 }).Count -ne 0) { throw 'Use a canonical four-component version.' }
$SourceRepository = LocalPath $SourceRepository
$DotnetPath = LocalPath $DotnetPath
$HelperPath = LocalPath $HelperPath
$HelperLicensePath = LocalPath $HelperLicensePath
if ($OfflinePackageSourceDirectory) { $OfflinePackageSourceDirectory = LocalPath $OfflinePackageSourceDirectory }
if ((Hash $HelperPath) -ne $helperSha -or (Hash $HelperLicensePath) -ne $licenseSha) { throw 'Pinned package input differs.' }
SignedBy $DotnetPath 'O=Microsoft Corporation'
SignedBy $HelperPath 'O="Cloudflare, Inc."'
$commitType = & git -C $SourceRepository cat-file -t $ReviewedCommit
if ($LASTEXITCODE -ne 0 -or $commitType -cne 'commit') { throw 'Reviewed source commit is unavailable.' }
$tree = & git -C $SourceRepository rev-parse "${ReviewedCommit}:apps/windows-download"
if ($LASTEXITCODE -ne 0) { throw 'Reviewed Windows source tree is unavailable.' }

$localData = LocalPath ([Environment]::GetFolderPath('LocalApplicationData'))
$parent = Join-Path $localData 'LedgeTopFilesConnectedBuilds'
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
& git -C $SourceRepository archive --format=zip "--output=$archive" $ReviewedCommit -- apps/windows-download apps/operations/public/favicon.ico scripts/windows-package-channel-check.ps1 scripts/windows-unsigned-installer.ps1 scripts/windows-package-runtime-notices.ps1 scripts/windows-explorer-preview-notices.ps1 scripts/windows-package-go-notices.ps1 docs/staging/windows-helper-module-notices-2026-10-22 docs/staging/windows-helper-build-provenance-2026-10-22/go-runtime-notices docs/staging/windows-helper-build-provenance-2026-10-22/go-runtime-notices.json
if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
$source = Join-Path $root 'source'
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $source)
$payload = Join-Path $root 'payload'
$publishLog = Join-Path $root 'publish.log'
$packageSource = if ($OfflinePackageSourceDirectory) { $OfflinePackageSourceDirectory } else { 'https://api.nuget.org/v3/index.json' }
Push-Location -LiteralPath (Join-Path $source 'apps/windows-download')
try {
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
  $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
  # Use a compiler process in this build's filesystem context. A cached compiler
  # server can outlive the app context and fail to see freshly generated inputs.
  # This changes build isolation only, not compiler validation or diagnostics.
  & $DotnetPath publish App/WindowsDownload.App.csproj -c Release -m:1 -r win-x64 --self-contained true `
    --source $packageSource --artifacts-path (Join-Path $root 'artifacts') -o $payload `
    -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false -p:UseSharedCompilation=false `
    -p:LedgeTopPackage=true -p:LedgeTopReleaseChannel=pilot -p:LedgeTopFreshStaging=true "-p:LedgeTopAppVersion=$AppVersion" *> $publishLog
  if ($LASTEXITCODE -ne 0) { throw 'Pilot publish failed; inspect the owned publish.log.' }
} finally { Pop-Location }
$archivedScripts = Join-Path $source 'scripts'
$checker = Join-Path $archivedScripts 'windows-package-channel-check.ps1'
$channel = & $checker -AssemblyPath (Join-Path $payload 'LedgeTop.Files.dll') -ExpectedChannel pilot | ConvertFrom-Json
if ([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $payload 'LedgeTop.Files.dll')).FileVersion -cne $AppVersion) {
  throw 'Published file version differs from the requested version.'
}
New-Item -ItemType Directory -Path (Join-Path $payload 'helper'),(Join-Path $payload 'Notices') | Out-Null
$sdkNotices = & (Join-Path $archivedScripts 'windows-explorer-preview-notices.ps1') -PayloadDirectory $payload -NugetPackagesDirectory $env:NUGET_PACKAGES -SourceNoticeDirectory (Join-Path $source 'apps/windows-download/Packaging/Notices') | ConvertFrom-Json
$runtimeNotices = & (Join-Path $archivedScripts 'windows-package-runtime-notices.ps1') -PayloadDirectory $payload -NugetPackagesDirectory $env:NUGET_PACKAGES -SourceNoticeDirectory (Join-Path $source 'apps/windows-download/Packaging/Notices') -IncludeExplorerSdk | ConvertFrom-Json
$moduleNoticeSource = Join-Path $source 'docs/staging/windows-helper-module-notices-2026-10-22'
$moduleManifestText = [IO.File]::ReadAllText((Join-Path $moduleNoticeSource 'manifest.json')).Replace("`r`n", "`n")
$moduleManifestBytes = [Text.Encoding]::UTF8.GetBytes($moduleManifestText)
$moduleManifestSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($moduleManifestBytes)).ToLowerInvariant()
if ($moduleManifestSha -cne '3b2a544ea71e1e6babc118a2c1888a3a3754f977f0b725526d03e7481dd63143') { throw 'Qualified helper module notice manifest differs.' }
$moduleManifest = $moduleManifestText | ConvertFrom-Json
if ($moduleManifest.helperSha256 -cne $helperSha -or $moduleManifest.moduleCount -ne 66 -or @($moduleManifest.modules.notices).Count -ne 99) { throw 'Helper module notice bundle is not for this qualified binary.' }
$moduleNoticeOutput = Join-Path $payload 'Notices/cloudflared-modules'
New-Item -ItemType Directory -Path $moduleNoticeOutput | Out-Null
foreach ($notice in $moduleManifest.modules.notices) {
  if ($notice.outputPath -cnotmatch '\A[0-9]{2}-[a-f0-9]{16}/[0-9]{3}-[A-Za-z0-9_.-]+\.txt\z') { throw 'Unexpected module notice output path.' }
  $inputNotice = Join-Path $moduleNoticeSource $notice.outputPath
  if ((Get-Item -LiteralPath $inputNotice).Length -ne $notice.bytes -or (Hash $inputNotice) -cne $notice.sha256) { throw 'Module notice bytes differ.' }
  $outputNotice = Join-Path $moduleNoticeOutput $notice.outputPath
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($outputNotice)) -Force | Out-Null
  Copy-Item -LiteralPath $inputNotice -Destination $outputNotice
}
[IO.File]::WriteAllBytes((Join-Path $moduleNoticeOutput 'manifest.json'), $moduleManifestBytes)
$goNotices = & (Join-Path $archivedScripts 'windows-package-go-notices.ps1') -SourceDirectory (Join-Path $source 'docs/staging/windows-helper-build-provenance-2026-10-22') -PayloadDirectory $payload -HelperSha256 $helperSha | ConvertFrom-Json
Copy-Item -LiteralPath $HelperPath -Destination (Join-Path $payload 'helper/cloudflared.exe')
Copy-Item -LiteralPath $HelperLicensePath -Destination (Join-Path $payload 'Notices/LICENSE.cloudflared.txt')
if ((Hash (Join-Path $payload 'helper/cloudflared.exe')) -ne $helperSha -or (Hash (Join-Path $payload 'Notices/LICENSE.cloudflared.txt')) -ne $licenseSha) { throw 'Copied package input differs.' }
$inventory = @(Get-ChildItem -LiteralPath $payload -File -Recurse | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse file in payload.' }
  [pscustomobject]@{path=[IO.Path]::GetRelativePath($payload,$_.FullName).Replace([IO.Path]::DirectorySeparatorChar,[char]'/');bytes=$_.Length;sha256=(Hash $_.FullName)}
} | Sort-Object path)
$inventoryPath = Join-Path $root 'payload-inventory.json'
$inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $inventoryPath -Encoding utf8
# This receipt is a construction record, not evidence of installation, source
# approval, real authentication, live transfer, update or migration safety.
$receipt = [ordered]@{
  status='connected_payload_unqualified';sourceCommit=$ReviewedCommit;sourceTree=$tree;sourceArchiveSha256=(Hash $archive)
  rid='win-x64';selfContained=$true;buildMode='packaged';compiledReleaseChannels=1;channel='pilot'
  applicationVersion=$AppVersion;applicationSha256=$channel.assemblySha256;helperSha256=$helperSha
  payloadFiles=$inventory.Count;payloadBytes=[long](($inventory | Measure-Object bytes -Sum).Sum)
  cloudflaredIncluded=$true;signed=$false;installerMaintenanceProtocol=1;freshGenerationStagingQualified=$false
  sdk=$sdk;dotnetSha256=(Hash $DotnetPath);builderSha256=(Hash $PSCommandPath);sourceAcceptanceVerified=$false;installed=$false;published=$false;liveTransferTested=$false
  inventorySha256=(Hash $inventoryPath);restoreSource=$packageSource;offlinePackageSourceUsed=[bool]$OfflinePackageSourceDirectory
  runtimeNotices=$runtimeNotices.notices;explorerSdkNotices=$sdkNotices
  helperModuleNotices=[ordered]@{manifestSha256=$moduleManifestSha;moduleCount=66;noticeFiles=99;completeThirdPartyAttribution=$false};goRuntimeNotices=$goNotices
}
$receiptPath = Join-Path $root 'build-receipt.json'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
# No build flag proves staging qualification. This receipt deliberately fails
# the installer validator until independently supported qualification exists.
[ordered]@{status='connected_payload_constructed_unqualified';outputRoot=$root;sourceCommit=$ReviewedCommit;version=$AppVersion;
  payload=$payload;inventory=$inventoryPath;receipt=$receiptPath;installerValidationAttempted=$false;installed=$false;signed=$false;published=$false;liveTransferTested=$false} | ConvertTo-Json -Depth 8
} catch {
  # Report only this task-created root, without dumping environment,
  # credentials, package-source details or helper output.
  [Console]::Error.WriteLine("Connected payload construction failed; task-owned output retained: $root")
  throw 'Connected payload construction failed; inspect the retained task-owned output.'
} finally {
  foreach ($name in $environmentNames) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name,$previousEnvironment[$name],'Process') }
  }
}
