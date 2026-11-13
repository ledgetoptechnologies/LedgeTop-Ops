param([Parameter(Mandatory)][string]$DotnetPath,[Parameter(Mandatory)][string]$OfflinePackageSource)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=Split-Path -Parent $PSScriptRoot;$project=Join-Path $repo 'apps/windows-download/Core/WindowsDownload.Core.csproj'
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('lt-memory-package-guard-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($scratch)|Out-Null
try {
 $cases=@(
  @('-p:LedgeTopPackage=true','-p:LedgeTopMemoryHydration=true'),
  @('-p:LedgeTopPackage=TrUe','-p:LedgeTopMemoryHydration=TRUE'),
  @('-p:LedgeTopPackage=true','-p:DefineConstants=LEDGETOP_MEMORY_HYDRATION'),
  @('-p:LedgeTopPackage=true','-p:DefineConstants=OTHER%3BLEDGETOP_MEMORY_HYDRATION'),
  @('-p:LedgeTopPackage=true','-p:DefineConstants=OTHER%2CLEDGETOP_MEMORY_HYDRATION'),
  @('-p:LedgeTopPackage=true','-p:DefineConstants=OTHER%3B%20ledgetop_memory_hydration%20%3BTHIRD')
 )
 foreach($case in $cases){$output=& $DotnetPath build $project -t:Rebuild -m:1 "-p:RestoreSources=$OfflinePackageSource" @case -v:q 2>&1 | Out-String;if($LASTEXITCODE -eq 0 -or $output -notmatch 'Experimental memory hydration is restricted'){throw ('Package refusal did not fire: '+($case -join ' '))}}
 $normal=Join-Path $scratch 'normal';$feature=Join-Path $scratch 'feature'
 foreach($item in @(@($normal,'false'),@($feature,'true'))){$output=& $DotnetPath build $project -t:Rebuild -m:1 -c Release -o $item[0] "-p:RestoreSources=$OfflinePackageSource" "-p:LedgeTopMemoryHydration=$($item[1])" -v:q 2>&1 | Out-String;if($LASTEXITCODE -ne 0){throw ('Nonpackaged build failed: '+$output)}}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1'),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Installer guard parse failed.'}
 $guard=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'AssertCoreHasNoNativeDiagnostics'},$true));if($guard.Count -ne 1){throw 'Core guard missing or ambiguous.'};Invoke-Expression $guard[0].Extent.Text
 $ManualStagingTest=$true;$good=Join-Path $normal 'LedgeTop.WindowsDownload.dll';$bad=Join-Path $feature 'LedgeTop.WindowsDownload.dll';$hash={param($p)(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
 AssertCoreHasNoNativeDiagnostics $good (& $hash $good)
 $refused=$false;try{AssertCoreHasNoNativeDiagnostics $bad (& $hash $bad)}catch{if($_.Exception.Message -notmatch 'restricted experimental memory hydration'){throw};$refused=$true};if(!$refused){throw 'Feature-on prebuilt Core was accepted.'}
 $refused=$false;try{AssertCoreHasNoNativeDiagnostics $good ('0'*64)}catch{$refused=$true};if(!$refused){throw 'Wrong inventory hash accepted.'}
 'PASS six packaged feature refusals; nonpackaged default and opt-in build; real default Core accepted, real opt-in Core and wrong hash refused.'
} finally {if(Test-Path -LiteralPath $scratch){$resolved=(Resolve-Path -LiteralPath $scratch).Path;$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath());if($resolved -cne $scratch -or !$resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -cnotmatch '^lt-memory-package-guard-[a-f0-9]{32}$'){throw 'Scratch cleanup path changed.'};Remove-Item -LiteralPath $resolved -Recurse -Force}}
