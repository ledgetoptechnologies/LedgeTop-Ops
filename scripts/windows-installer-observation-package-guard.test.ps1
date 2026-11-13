param([Parameter(Mandatory)][string]$DotnetPath)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$project=Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/windows-download/App/WindowsDownload.App.csproj'
$cases=@(
 @('-p:LedgeTopPackage=true','-p:LedgeTopInstallerObservationTest=TrUe'),
 @('-p:LedgeTopPackage=TrUe','-p:LedgeTopInstallerObservationTest=TRUE'),
 @('-p:LedgeTopPackage=true','-p:DefineConstants=LEDGETOP_INSTALLER_OBSERVATION_TEST'),
 @('-p:LedgeTopPackage=true','-p:DefineConstants=OTHER%3BLEDGETOP_INSTALLER_OBSERVATION_TEST'),
 @('-p:LedgeTopPackage=true','-p:DefineConstants=OTHER%2CLEDGETOP_INSTALLER_OBSERVATION_TEST'),
 @('-p:LedgeTopPackage=true','-p:DefineConstants=OTHER%3B%20LEDGETOP_INSTALLER_OBSERVATION_TEST%20%3BTHIRD')
)
foreach($case in $cases) {
 $output=& $DotnetPath build $project --no-restore -m:1 -p:LedgeTopReleaseChannel=pilot @case -v:q 2>&1 | Out-String
 if($LASTEXITCODE-eq 0 -or $output-notmatch 'Installer observation instrumentation cannot be packaged'){throw ('Unexpected package guard outcome: '+($case -join ' '))}
}
'PASS six package refusals: mixed-case flags, direct definition, comma/semicolon separators and whitespace.'
