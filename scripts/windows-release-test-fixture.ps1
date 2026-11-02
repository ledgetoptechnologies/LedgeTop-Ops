param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$HelperPath,
  [Parameter(Mandatory)][string]$CoreAssemblyPath,
  [Parameter(Mandatory)][string]$CompilerPath,
  [Parameter(Mandatory)][string]$DotnetPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ReviewedCommit,
  [string]$SourceRepository=([IO.Path]::GetDirectoryName($PSScriptRoot))
)
$ErrorActionPreference='Stop'
# Synthetic metadata fixture only. The pinned compiler emits an Abort-only PE
# for version-resource validation. No generated PE, app, helper, browser, API,
# installation or uninstallation is executed. Other runtime files are text.
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
if(-not[IO.Path]::IsPathFullyQualified($OutputDirectory)-or$OutputDirectory.StartsWith('\\')-or(Test-Path -LiteralPath $OutputDirectory)){throw 'Use a new absolute local fixture directory.'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
for($part=[IO.Path]::GetDirectoryName($output);$null-ne$part;$part=[IO.Path]::GetDirectoryName($part)){
  if(Test-Path -LiteralPath $part){if(([IO.File]::GetAttributes($part)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Fixture ancestor cannot be an alias.'}}
}
foreach($inputFile in @($HelperPath,$CoreAssemblyPath,$CompilerPath)){
  $attributes=[IO.File]::GetAttributes($inputFile)
  if(($attributes-band([IO.FileAttributes]::ReparsePoint-bor[IO.FileAttributes]::Directory))-ne0){throw 'Fixture inputs must be regular non-reparse files.'}
}
if((Hash $HelperPath)-cne'76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'){throw 'Fixture requires exact qualified helper bytes, never execution.'}
if((Hash $CompilerPath)-cne'65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a'){throw 'Fixture requires exact qualified NSIS compiler.'}
function GitBytes([string[]]$arguments){
  $start=[Diagnostics.ProcessStartInfo]::new('git');$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($arg in @('-C',$SourceRepository)+$arguments){$start.ArgumentList.Add($arg)}
  $process=[Diagnostics.Process]::Start($start);$bytes=[IO.MemoryStream]::new();$copy=$process.StandardOutput.BaseStream.CopyToAsync($bytes);$errorRead=$process.StandardError.ReadToEndAsync()
  $process.WaitForExit();$null=$copy.GetAwaiter().GetResult();$null=$errorRead.GetAwaiter().GetResult()
  try{if($process.ExitCode-ne0){throw 'Fixture reviewed source unavailable.'};return ,$bytes.ToArray()}finally{$bytes.Dispose();$process.Dispose()}
}
$templateBlob=[Text.Encoding]::UTF8.GetString((GitBytes @('rev-parse',($ReviewedCommit+':apps/windows-download/Packaging/UnsignedInstaller.nsi')))).Trim()
$template=GitBytes @('cat-file','blob',$templateBlob)
$builder=Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1'
$reviewedBuilder=GitBytes @('show',($ReviewedCommit+':scripts/windows-unsigned-installer.ps1'))
if([Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($reviewedBuilder))-cne(Hash $builder)){throw 'Fixture requires the exact reviewed input guard.'}
$payload=Join-Path $output 'payload';$app=Join-Path $payload 'app';$installer=Join-Path $output 'installer'
foreach($dir in @($app,(Join-Path $app 'helper'),(Join-Path $app 'Notices'),$installer)){[IO.Directory]::CreateDirectory($dir)|Out-Null}
$version='0.5.1.0';$type='ReleaseFixture'+[Guid]::NewGuid().ToString('N')
if((& $DotnetPath --version)-cne'10.0.402'){throw 'Fixture requires reviewed SDK 10.0.402.'}
$project=Join-Path $output 'metadata-project';[IO.Directory]::CreateDirectory($project)|Out-Null
[IO.File]::WriteAllText((Join-Path $project 'Fixture.cs'),@"
using System.Reflection;
[assembly:AssemblyVersion("$version")]
[assembly:AssemblyFileVersion("$version")]
[assembly:AssemblyInformationalVersion("$version")]
[assembly:AssemblyMetadata("LedgeTop.ReleaseChannel","pilot")]
[assembly:AssemblyMetadata("LedgeTop.InstallerMaintenanceProtocol","1")]
internal sealed class $type { }
"@
)
[IO.File]::WriteAllText((Join-Path $project 'Fixture.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AssemblyName>LedgeTop.Files</AssemblyName><GenerateAssemblyInfo>false</GenerateAssemblyInfo></PropertyGroup></Project>')
$buildLog=& $DotnetPath build (Join-Path $project 'Fixture.csproj') --configuration Release --artifacts-path (Join-Path $output 'metadata-build') -p:UseSharedCompilation=false ("-p:RestoreConfigFile="+(Join-Path $SourceRepository 'apps/windows-download/NuGet.Config')) 2>&1
$buildExit=$LASTEXITCODE;[IO.File]::WriteAllText((Join-Path $output 'metadata-build.log'),($buildLog-join"`n"))
if($buildExit-ne0){throw 'Synthetic metadata assembly build failed.'}
Copy-Item -LiteralPath (Join-Path $output 'metadata-build/bin/Fixture/release/LedgeTop.Files.dll') -Destination (Join-Path $app 'LedgeTop.Files.dll')
foreach($name in @('LedgeTop.Files.exe','LedgeTop.Files.deps.json','LedgeTop.Files.runtimeconfig.json','coreclr.dll','hostfxr.dll','hostpolicy.dll','Notices/LICENSE.cloudflared.txt')){
  [IO.File]::WriteAllText((Join-Path $app $name),'SYNTHETIC METADATA FIXTURE; NEVER EXECUTE.')
}
Copy-Item -LiteralPath $HelperPath -Destination (Join-Path $app 'helper/cloudflared.exe')
Copy-Item -LiteralPath $CoreAssemblyPath -Destination (Join-Path $app 'LedgeTop.WindowsDownload.dll')
$inventory=@(Get-ChildItem -LiteralPath $app -File -Recurse|ForEach-Object{[pscustomobject][ordered]@{path=[IO.Path]::GetRelativePath($app,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=Hash $_.FullName}}|Sort-Object {$_.path})
$inventoryPath=Join-Path $payload 'payload-inventory.json';$buildPath=Join-Path $payload 'build-receipt.json'
$archiveHash=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('synthetic source association only')))
$build=[ordered]@{status='private_connected_staging_pilot';sourceCommit=$ReviewedCommit;rid='win-x64';selfContained=$true;buildMode='packaged';compiledReleaseChannels=1;channel='pilot';applicationVersion=$version;applicationSha256=Hash (Join-Path $app 'LedgeTop.Files.dll');helperSha256=Hash $HelperPath;payloadFiles=$inventory.Count;payloadBytes=[long](($inventory|Measure-Object bytes -Sum).Sum);cloudflaredIncluded=$true;signed=$false;installerMaintenanceProtocol=1;sourceArchiveSha256=$archiveHash}
$inventory|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $inventoryPath -Encoding utf8
$build|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $buildPath -Encoding utf8
$dummy=Join-Path $installer "LedgeTop-Files-Pilot-$version-unsigned-setup.exe"
$literalOutput=$dummy.Replace('$','$$').Replace('"','$\"')
$nsi=Join-Path $output 'synthetic-never-execute.nsi'
[IO.File]::WriteAllText($nsi,@"
Unicode true
Name "Synthetic metadata test fixture - never execute"
OutFile "$literalOutput"
RequestExecutionLevel user
SilentInstall silent
VIProductVersion "$version"
VIAddVersionKey /LANG=1033 "FileVersion" "$version"
VIAddVersionKey /LANG=1033 "ProductName" "Synthetic metadata fixture"
VIAddVersionKey /LANG=1033 "FileDescription" "Test-only Abort PE; never execute"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Synthetic fixture"
Section
Abort
SectionEnd
"@,[Text.UTF8Encoding]::new($false))
$compile=[Diagnostics.ProcessStartInfo]::new($CompilerPath);$compile.UseShellExecute=$false;$compile.CreateNoWindow=$true;$compile.RedirectStandardOutput=$true;$compile.RedirectStandardError=$true
$compile.Environment['NSISDIR']=[IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($CompilerPath))
$compile.Environment['NSISCONFDIR']=$output
foreach($arg in @('/NOCONFIG','/WX',$nsi)){$compile.ArgumentList.Add($arg)}
$process=[Diagnostics.Process]::Start($compile);$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
try{[IO.File]::WriteAllText((Join-Path $output 'synthetic-compiler.log'),$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult());if($process.ExitCode-ne0){throw 'Synthetic metadata PE compilation failed.'}}finally{$process.Dispose()}
$receipt=[ordered]@{schemaVersion=1;status='unsigned_manual_pilot_installer_constructed';sourceCommit=$ReviewedCommit;sourceArchiveSha256=$archiveHash;appVersion=$version;channel='pilot';buildMode='packaged';installerMaintenanceProtocol=1;templateBlob=$templateBlob;templateSha256=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($template));builderSha256=Hash $builder;payloadInventorySha256=Hash $inventoryPath;buildReceiptSha256=Hash $buildPath;applicationSha256=$build.applicationSha256;installerSha256=Hash $dummy;payloadFiles=$inventory.Count;payloadBytes=$build.payloadBytes;installerBytes=[long](Get-Item -LiteralPath $dummy).Length;signed=$false;installed=$false;uninstalled=$false;published=$false;autoUpdateEnabled=$false;forceShutdown=$false;executedApplication=$false;syntheticTestOnly=$true}
$receipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $installer 'installer-build-receipt.json') -Encoding utf8
[ordered]@{syntheticTestOnly=$true;installerDirectory=$installer;payloadDirectory=$payload;sourceRepository=$SourceRepository;applicationExecuted=$false;helperExecuted=$false;installerExecuted=$false}|ConvertTo-Json
