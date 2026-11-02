param(
  [Parameter(Mandatory)][string]$SourcePayloadDirectory,
  [Parameter(Mandatory)][string]$NugetPackagesDirectory
)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'windows-explorer-preview-notices.ps1'
$notices = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../apps/windows-download/Packaging/Notices'))
$testParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $testParent ('ltfiles-sdk-notice-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$passed = 0
function Check([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Payload([string]$name) {
  $path = Join-Path $testRoot $name; $null = New-Item -ItemType Directory -Path $path
  foreach ($file in @('LedgeTop.Files.deps.json','LedgeTop.Files.runtimeconfig.json','Microsoft.Windows.SDK.NET.dll','WinRT.Runtime.dll')) {
    Copy-Item -LiteralPath (Join-Path $SourcePayloadDirectory $file) -Destination (Join-Path $path $file)
  }
  $path
}
function Refuses([scriptblock]$action, [string]$message) {
  $refused = $false
  try { & $action | Out-Null } catch { $refused = $true }
  Check $refused $message
}
try {
  $good = Payload 'good'
  $receipt = & $helper -PayloadDirectory $good -NugetPackagesDirectory $NugetPackagesDirectory | ConvertFrom-Json
  Check ($receipt.sdkAssemblyNoticesIncluded -and $receipt.binaries.Count -eq 2 -and $receipt.notices.Count -eq 3) 'Expected SDK assembly/notice receipt.'
  foreach ($notice in $receipt.notices) {
    Check ((Get-FileHash -LiteralPath (Join-Path $good $notice.path)).Hash.ToLowerInvariant() -ceq $notice.sha256) 'Copied notice hash differs.'
  }
  $passed++
  $timestamps = @(Get-ChildItem -LiteralPath (Join-Path $good 'Notices') -File | Sort-Object Name | ForEach-Object { $_.LastWriteTimeUtc.Ticks }) -join ','
  & $helper -PayloadDirectory $good -NugetPackagesDirectory $NugetPackagesDirectory -VerifyOnly | Out-Null
  & $helper -PayloadDirectory $good -NugetPackagesDirectory $NugetPackagesDirectory | Out-Null
  $after = @(Get-ChildItem -LiteralPath (Join-Path $good 'Notices') -File | Sort-Object Name | ForEach-Object { $_.LastWriteTimeUtc.Ticks }) -join ','
  Check ($timestamps -ceq $after) 'Readback/idempotent composition unexpectedly rewrote notices.'
  $passed++

  $wrongBinary = Payload 'wrong-binary'
  $stream = [IO.File]::OpenWrite((Join-Path $wrongBinary 'WinRT.Runtime.dll'))
  try { $stream.WriteByte(0) } finally { $stream.Dispose() }
  Refuses { & $helper -PayloadDirectory $wrongBinary -NugetPackagesDirectory $NugetPackagesDirectory } 'Changed SDK binary accepted.'
  Check (-not (Test-Path -LiteralPath (Join-Path $wrongBinary 'Notices'))) 'Changed binary wrote notices before refusal.'
  $passed++

  $wrongDeps = Payload 'wrong-dependency'
  $path = Join-Path $wrongDeps 'LedgeTop.Files.deps.json'
  [IO.File]::WriteAllText($path, [IO.File]::ReadAllText($path).Replace('runtimepack.Microsoft.Windows.SDK.NET.Ref/10.0.22621.57','runtimepack.Microsoft.Windows.SDK.NET.Ref/10.0.22621.58'))
  Refuses { & $helper -PayloadDirectory $wrongDeps -NugetPackagesDirectory $NugetPackagesDirectory } 'Unreviewed SDK dependency accepted.'
  Check (-not (Test-Path -LiteralPath (Join-Path $wrongDeps 'Notices'))) 'Wrong dependency wrote notices before refusal.'
  $passed++

  $wrongSource = Join-Path $testRoot 'source-notices'; $null = New-Item -ItemType Directory -Path $wrongSource
  foreach ($notice in $receipt.notices) { Copy-Item -LiteralPath (Join-Path $notices ([IO.Path]::GetFileName($notice.path))) -Destination $wrongSource }
  [IO.File]::WriteAllText((Join-Path $wrongSource 'LICENSE.CsWinRT.txt'), 'changed source notice')
  $badSourcePayload = Payload 'wrong-source-notice'
  Refuses { & $helper -PayloadDirectory $badSourcePayload -NugetPackagesDirectory $NugetPackagesDirectory -SourceNoticeDirectory $wrongSource } 'Changed source notice accepted.'
  Check (-not (Test-Path -LiteralPath (Join-Path $badSourcePayload 'Notices'))) 'Wrong notice wrote outputs before refusal.'
  $passed++

  $existing = Payload 'existing-notice'; $null = New-Item -ItemType Directory -Path (Join-Path $existing 'Notices')
  $keep = Join-Path $existing 'Notices/LICENSE.CsWinRT.txt'; [IO.File]::WriteAllText($keep, 'retain this existing file')
  $keepHash = (Get-FileHash -LiteralPath $keep).Hash
  Refuses { & $helper -PayloadDirectory $existing -NugetPackagesDirectory $NugetPackagesDirectory } 'Unexpected existing notice accepted.'
  Check ((Get-FileHash -LiteralPath $keep).Hash -ceq $keepHash) 'Unexpected existing notice was overwritten.'
  Check (@(Get-ChildItem -LiteralPath (Join-Path $existing 'Notices') -File).Count -eq 1) 'Conflict wrote other outputs before refusal.'
  $passed++

  $badPackageRoot = Join-Path $testRoot 'packages'
  $packagePart = 'microsoft.windows.sdk.net.ref/10.0.22621.57/microsoft.windows.sdk.net.ref.10.0.22621.57.nupkg'
  $badPackage = Join-Path $badPackageRoot $packagePart
  $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($badPackage)) -Force
  Copy-Item -LiteralPath (Join-Path $NugetPackagesDirectory $packagePart) -Destination $badPackage
  $stream = [IO.File]::OpenWrite($badPackage); try { $stream.WriteByte(0) } finally { $stream.Dispose() }
  $badPackagePayload = Payload 'wrong-package'
  Refuses { & $helper -PayloadDirectory $badPackagePayload -NugetPackagesDirectory $badPackageRoot } 'Changed vendor package accepted.'
  Check (-not (Test-Path -LiteralPath (Join-Path $badPackagePayload 'Notices'))) 'Wrong package wrote outputs before refusal.'
  $passed++
  $runtimeHelper = Join-Path $PSScriptRoot 'windows-package-runtime-notices.ps1'
  Refuses { & $runtimeHelper -PayloadDirectory $good -NugetPackagesDirectory $NugetPackagesDirectory } 'Legacy runtime check silently accepted an extra SDK runtimepack.'
  # Actual release construction runs with strict property access. Both package-backed
  # and source-backed notices must serialize their nonapplicable provenance fields as null.
  $runtimeReceipt = & {
    Set-StrictMode -Version Latest
    & $runtimeHelper -PayloadDirectory $good -NugetPackagesDirectory $NugetPackagesDirectory -IncludeExplorerSdk
  } | ConvertFrom-Json
  Check ($runtimeReceipt.notices.Count -eq 5 -and -not $runtimeReceipt.completeThirdPartyAttribution) 'Expected separately scoped five-runtime-notice receipt.'
  Check (@($runtimeReceipt.notices | Where-Object { $null -ne $_.packageId -and $null -eq $_.sourceUrl }).Count -eq 3 -and
    @($runtimeReceipt.notices | Where-Object { $null -ne $_.sourceUrl -and $null -eq $_.packageId -and $null -eq $_.packageSha256 -and $null -eq $_.packageEntry }).Count -eq 2) 'Notice provenance variants lost their explicit null fields.'
  Check (@(Get-ChildItem -LiteralPath (Join-Path $good 'Notices') -File).Count -eq 8) 'Composed payload must retain all eight verified vendor notice files.'
  $passed++

  $missingSdkNotices = Payload 'missing-sdk-notices'
  Refuses { & $runtimeHelper -PayloadDirectory $missingSdkNotices -NugetPackagesDirectory $NugetPackagesDirectory -IncludeExplorerSdk } 'Runtime composition accepted missing SDK notices.'
  Check (-not (Test-Path -LiteralPath (Join-Path $missingSdkNotices 'Notices'))) 'Refused runtime composition wrote partial outputs.'
  $passed++
  Write-Output "$passed/9 Windows SDK and runtime notice acceptance cases passed; isolated copies only."
} finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  if (-not $resolved.StartsWith($testParent, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notmatch '^ltfiles-sdk-notice-tests-[a-f0-9]{32}$') { throw 'Refusing unexpected test cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
