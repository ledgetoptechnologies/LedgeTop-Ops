param(
  [Parameter(Mandatory)][string]$SourceRepository,
  [Parameter(Mandatory)][string]$ReviewedCommit,
  [Parameter(Mandatory)][string]$DotnetPath,
  [Parameter(Mandatory)][string]$HelperPath,
  [Parameter(Mandatory)][string]$HelperLicensePath,
  [string]$UnqualifiedBuildRoot,
  [switch]$ExerciseFailureRoot
)
$ErrorActionPreference = 'Stop'
$builder = Join-Path $PSScriptRoot 'windows-connected-pilot-payload.ps1'
$base = @{ SourceRepository=$SourceRepository; ReviewedCommit=$ReviewedCommit; DotnetPath=$DotnetPath;
  AppVersion='0.0.0.5'; HelperPath=$HelperPath; HelperLicensePath=$HelperLicensePath }
function Refuses([hashtable]$Overrides, [string]$Expected) {
  $arguments = @{}; foreach ($entry in $base.GetEnumerator()) { $arguments[$entry.Key] = $entry.Value }
  foreach ($entry in $Overrides.GetEnumerator()) { $arguments[$entry.Key] = $entry.Value }
  try { & $builder @arguments | Out-Null } catch {
    if ($_.Exception.Message -like "*$Expected*") { return }
    throw "Unexpected refusal: $($_.Exception.Message)"
  }
  throw "Builder unexpectedly accepted invalid input: $Expected"
}
Refuses @{AppVersion='00.0.0.5'} 'canonical four-component version'
Refuses @{AppVersion='0.0.0.65536'} 'canonical four-component version'
Refuses @{HelperPath=$HelperLicensePath} 'Pinned package input differs'
Refuses @{ReviewedCommit=('0' * 40)} 'Reviewed source commit is unavailable'
Write-Output 'PASS invalid version, unpinned helper and missing source fail before construction.'
if ($UnqualifiedBuildRoot) {
  $receipt = Get-Content -LiteralPath (Join-Path $UnqualifiedBuildRoot 'build-receipt.json') -Raw | ConvertFrom-Json
  if ($receipt.status -cne 'connected_payload_unqualified' -or $receipt.freshGenerationStagingQualified -ne $false -or
      $receipt.sourceCommit -cne $ReviewedCommit -or $receipt.installed -ne $false -or $receipt.published -ne $false) {
    throw 'Payload incorrectly claims qualification or installation.'
  }
  $validationOutput = Join-Path $UnqualifiedBuildRoot ('test-must-not-exist-' + [Guid]::NewGuid().ToString('N'))
  try {
    & (Join-Path $UnqualifiedBuildRoot 'source/scripts/windows-unsigned-installer.ps1') `
      -PayloadDirectory (Join-Path $UnqualifiedBuildRoot 'payload') -PayloadInventoryPath (Join-Path $UnqualifiedBuildRoot 'payload-inventory.json') `
      -BuildReceiptPath (Join-Path $UnqualifiedBuildRoot 'build-receipt.json') -ReviewedCommit $ReviewedCommit `
      -AppVersion $receipt.applicationVersion -OutputDirectory $validationOutput -SourceRepository $SourceRepository -ValidateOnly | Out-Null
    throw 'Validator unexpectedly accepted an unqualified payload.'
  } catch {
    if ($_.Exception.Message -notlike '*outside the approved unsigned pilot construction scope*') { throw }
  }
  if (Test-Path -LiteralPath $validationOutput) { throw 'Unexpected validation output exists.' }
  Write-Output 'PASS installer validator rejects the unqualified construction receipt.'
}
if ($ExerciseFailureRoot) {
  # Launch only this test-owned child. The source scripts folder contains no
  # NuGet packages, so its isolated restore fails after creating its root.
  $start = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  foreach ($arg in @('-NoProfile','-File',$builder,'-SourceRepository',$SourceRepository,'-ReviewedCommit',$ReviewedCommit,
      '-DotnetPath',$DotnetPath,'-AppVersion','0.0.0.5','-HelperPath',$HelperPath,'-HelperLicensePath',$HelperLicensePath,
      '-OfflinePackageSourceDirectory',(Join-Path $SourceRepository 'scripts'))) { $start.ArgumentList.Add($arg) }
  $child = [Diagnostics.Process]::Start($start)
  $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
  if (-not $child.WaitForExit(120000)) { throw "Failure test child $($child.Id) is still running; retain its resources for inspection." }
  try {
    $out = $stdout.GetAwaiter().GetResult(); $err = $stderr.GetAwaiter().GetResult()
    $match = [regex]::Match($err, 'Connected payload construction failed; task-owned output retained: ([^\r\n]+)')
    if ($child.ExitCode -eq 0 -or -not $match.Success -or $out -match 'connected_payload_constructed') { throw 'Expected redacted failure and owned-root report.' }
    $root = $match.Groups[1].Value.Trim()
    $parent = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'LedgeTopFilesConnectedBuilds'
    if ([IO.Path]::GetDirectoryName($root) -cne $parent -or [IO.Path]::GetFileName($root) -cnotmatch '\A[a-f0-9]{32}\z' -or
        -not (Test-Path -LiteralPath (Join-Path $root 'publish.log') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $root 'build-receipt.json'))) { throw 'Reported failure root is not the retained build evidence.' }
    Write-Output "PASS redacted failure reports retained task-owned root: $root"
  } finally { $child.Dispose() }
}
