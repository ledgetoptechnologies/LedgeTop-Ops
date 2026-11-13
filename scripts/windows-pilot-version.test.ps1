param([Parameter(Mandatory)][string]$DotnetPath)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '../apps/windows-download/App/WindowsDownload.App.csproj'
function Check([string]$Name, [string[]]$Properties, [bool]$Reject, [string]$ExpectedError) {
  $output = @(& $DotnetPath msbuild $project -t:RequireFreshStagingVersion '-p:LedgeTopFreshStaging=true' @Properties -nologo 2>&1)
  if (($LASTEXITCODE -ne 0) -ne $Reject -or ($Reject -and "$output" -notmatch $ExpectedError)) { throw "Unexpected $Name result: $output" }
}
Check 'valid version' @('-p:LedgeTopAppVersion=0.5.35.0') $false ''
Check 'maximum components' @('-p:LedgeTopAppVersion=65535.0.1.2') $false ''
foreach ($value in @('', '01.2.3.4', '1.2.3', '65536.1.2.3')) {
  Check "invalid version $value" @("-p:LedgeTopAppVersion=$value") $true 'canonical four-part version'
}
foreach ($property in @('Version','AssemblyVersion','FileVersion')) {
  Check "conflicting $property" @('-p:LedgeTopAppVersion=0.5.35.0', "-p:$property=1.0.0.0") $true 'must match'
}
$output = & $DotnetPath msbuild $project '-p:LedgeTopFreshStaging=true' '-p:LedgeTopAppVersion=0.5.35.0' '-getProperty:Version,AssemblyVersion,FileVersion' -nologo
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect resolved version properties.' }
$resolved = ($output | ConvertFrom-Json).Properties
foreach ($property in @('Version','AssemblyVersion','FileVersion')) {
  if ($resolved.$property -cne '0.5.35.0') { throw "$property was not stamped from LedgeTopAppVersion." }
}
'Connected pilot version guard and property checks passed.'
