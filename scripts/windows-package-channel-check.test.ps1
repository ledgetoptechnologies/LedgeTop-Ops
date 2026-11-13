param(
  [Parameter(Mandatory)][string]$CleanPilotAssembly,
  [Parameter(Mandatory)][string]$SyntheticPilotAssembly
)
$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'windows-package-channel-check.ps1'
$clean = & $checker -AssemblyPath $CleanPilotAssembly -ExpectedChannel pilot | ConvertFrom-Json
if ($clean.channel -cne 'pilot' -or $clean.executedApplication -ne $false) { throw 'Clean package metadata check failed.' }
$refused = $false
try { & $checker -AssemblyPath $SyntheticPilotAssembly -ExpectedChannel pilot | Out-Null }
catch {
  if ($_.Exception.Message -cne 'Package application contains a forbidden synthetic reconnect test seam.') { throw }
  $refused = $true
}
if (-not $refused) { throw 'Synthetic reconnect fixture was not rejected.' }
Write-Output 'PASS package metadata rejects synthetic reconnect fixture without loading application code.'
