param(
  [Parameter(Mandatory)][string]$OutputRoot,
  [Parameter(Mandatory)][string]$DotnetPath,
  [Parameter(Mandatory)][string]$SourcePackagePath,
  [string]$RuntimePackageDirectory
)
$ErrorActionPreference='Stop'
$bootstrap=Join-Path $PSScriptRoot 'windows-bootstrap-sdk-reference.ps1'
if(-not[IO.Path]::IsPathFullyQualified($OutputRoot)-or(Test-Path -LiteralPath $OutputRoot)){throw 'Use a new absolute test directory.'}
[IO.Directory]::CreateDirectory($OutputRoot)|Out-Null
$passed=0
function Refuses([string]$name,[hashtable]$changes){
  $output=Join-Path $OutputRoot $name
  $arguments=@{OutputDirectory=$output;DotnetPath=$DotnetPath;SourcePackagePath=$SourcePackagePath}
  foreach($key in $changes.Keys){$arguments[$key]=$changes[$key]}
  $refused=$false;try{& $bootstrap @arguments|Out-Null}catch{$refused=$true}
  if(-not$refused-or[IO.Directory]::Exists($output)){throw "Prerequisite refusal failed: $name"}
  $script:passed++
}
$bad=Join-Path $OutputRoot 'synthetic-invalid-package.nupkg';[IO.File]::WriteAllText($bad,'synthetic, never execute')
Refuses 'wrong-package' @{SourcePackagePath=$bad}
Refuses 'missing-package' @{SourcePackagePath=(Join-Path $OutputRoot 'absent.nupkg')}
Refuses 'relative-output' @{OutputDirectory='relative'}
Refuses 'unc-output' @{OutputDirectory='\\synthetic.invalid\never-access'}
$existing=Join-Path $OutputRoot 'existing';[IO.Directory]::CreateDirectory($existing)|Out-Null
$marker=Join-Path $existing 'retained.txt';[IO.File]::WriteAllText($marker,'retained synthetic evidence')
$refused=$false;try{& $bootstrap -OutputDirectory $existing -DotnetPath $DotnetPath -SourcePackagePath $SourcePackagePath|Out-Null}catch{$refused=$true}
if(-not$refused-or[IO.File]::ReadAllText($marker)-cne'retained synthetic evidence'){throw 'Existing prerequisite output changed.'};$passed++
$notices=Join-Path $OutputRoot 'bad-notices';[IO.Directory]::CreateDirectory($notices)|Out-Null
foreach($name in @('LICENSE.Windows.SDK.rtf','LICENSE.CsWinRT.txt','THIRD-PARTY-NOTICES.CsWinRT.txt')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../apps/windows-download/Packaging/Notices/$name") -Destination (Join-Path $notices $name)
}
[IO.File]::AppendAllText((Join-Path $notices 'LICENSE.CsWinRT.txt'),'tampered synthetic notice')
Refuses 'wrong-license' @{NoticeDirectory=$notices}
$positive=Join-Path $OutputRoot 'offline-positive'
$receipt=& $bootstrap -OutputDirectory $positive -DotnetPath $DotnetPath -SourcePackagePath $SourcePackagePath|ConvertFrom-Json
if($receipt.downloaded-or$receipt.signatureVerificationExitCode-ne0-or$receipt.licenseFiles.Count-ne3-or$receipt.globalSettingsChanged-or$receipt.softwareInstalled){throw 'Offline prerequisite receipt differs.'};$passed++
if($RuntimePackageDirectory){
  $invalid=Join-Path $OutputRoot 'invalid-runtime-cache';$id='microsoft.aspnetcore.app.runtime.win-x64';$dir=Join-Path $invalid "$id/10.0.13";[IO.Directory]::CreateDirectory($dir)|Out-Null
  $file=Join-Path $dir "$id.10.0.13.nupkg";[IO.File]::WriteAllText($file,'synthetic invalid runtime package')
  foreach($case in @('invalid-runtime','missing-runtime')){
    $out=Join-Path $OutputRoot $case;$inputDir=if($case-eq'invalid-runtime'){$invalid}else{Join-Path $OutputRoot 'missing-runtime-cache'}
    $refused=$false;try{& $bootstrap -OutputDirectory $out -DotnetPath $DotnetPath -SourcePackagePath $SourcePackagePath -IncludeRuntimePacks -RuntimePackageDirectory $inputDir|Out-Null}catch{$refused=$true}
    if(-not$refused-or(Test-Path (Join-Path $out 'receipt.json'))-or(Test-Path (Join-Path $out 'NuGet.Config'))){throw 'Invalid runtime input produced a ready feed.'};$passed++
  }
  $out=Join-Path $OutputRoot 'runtime-positive'
  $receipt=& $bootstrap -OutputDirectory $out -DotnetPath $DotnetPath -SourcePackagePath $SourcePackagePath -IncludeRuntimePacks -RuntimePackageDirectory $RuntimePackageDirectory|ConvertFrom-Json
  if($receipt.runtimePackages.Count-ne3-or@($receipt.runtimePackages|Where-Object signatureVerificationExitCode -NE 0).Count-ne0-or$receipt.globalSettingsChanged-or$receipt.softwareInstalled){throw 'Runtime prerequisite receipt differs.'};$passed++
}
[ordered]@{testsPassed=$passed;networkDownloadUsed=$false;applicationExecuted=$false;softwareInstalled=$false}|ConvertTo-Json
