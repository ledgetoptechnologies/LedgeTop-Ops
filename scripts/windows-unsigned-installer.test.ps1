param(
  [Parameter(Mandatory)][string]$HelperPath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [string]$SourceRepository = ([IO.Path]::GetDirectoryName($PSScriptRoot)),
  [string]$DotnetPath = (Get-Command dotnet).Source,
  [switch]$RequirePositiveValidation,
  [string]$ManualStagingAssemblyPath,
  [string]$PreviousManualStagingAssemblyPath
)
$ErrorActionPreference = 'Stop'
$builder = Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('LedgeTopUnsignedBuilderTests-'+[Guid]::NewGuid().ToString('N'))
$payload = Join-Path $root 'Payload'; [IO.Directory]::CreateDirectory($payload) | Out-Null
foreach ($directory in @('helper','Notices')) { [IO.Directory]::CreateDirectory((Join-Path $payload $directory)) | Out-Null }
# Metadata fixture only: no app methods, browser/helper calls or installer compilation/execution.
$type = 'InstallerFixture'+[Guid]::NewGuid().ToString('N')
Add-Type -OutputAssembly (Join-Path $payload 'LedgeTop.Files.dll') -TypeDefinition @"
using System.Reflection;
[assembly:AssemblyVersion("0.0.0.5")]
[assembly:AssemblyMetadata("LedgeTop.ReleaseChannel","pilot")]
[assembly:AssemblyMetadata("LedgeTop.InstallerMaintenanceProtocol","1")]
[assembly:AssemblyMetadata("LedgeTop.FreshGenerationStagingQualification","true")]
internal sealed class $type { }
"@
function BuildCoreFixture([string]$Name,[bool]$IncludeTrace,[bool]$IncludeCandidate=$false) {
  $folder=Join-Path $root $Name; [IO.Directory]::CreateDirectory($folder) | Out-Null
  $project=Join-Path $folder 'fixture.csproj'
  [IO.File]::WriteAllText($project,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AssemblyName>LedgeTop.WindowsDownload</AssemblyName></PropertyGroup></Project>')
  [IO.File]::WriteAllText((Join-Path $folder 'NuGet.Config'),'<configuration><packageSources><clear /></packageSources></configuration>')
  $trace=if($IncludeTrace){'internal class NativeStallTrace { }'}else{''}
  $candidate=if($IncludeCandidate){'internal class ExperimentalEntryLease { }'}else{''}
  [IO.File]::WriteAllText((Join-Path $folder 'Fixture.cs'),"namespace LedgeTop.WindowsDownload { internal class CloudFilesConnectionOwner { } internal class CloudFilesNativeTransfer { } public class PlaceholderHydrationCoordinator { } $trace $candidate }")
  $output=@(& $DotnetPath build $project --configuration Release --nologo --verbosity quiet 2>&1)
  if($LASTEXITCODE -ne 0){throw "Core fixture compilation failed: $output"}
  return (Join-Path $folder 'bin\Release\net10.0\LedgeTop.WindowsDownload.dll')
}
$normalCore=BuildCoreFixture 'NormalCore' $false
[IO.File]::Copy($normalCore,(Join-Path $payload 'LedgeTop.WindowsDownload.dll'))
function BuildExplorerFixture([string]$Name,[bool]$IncludeDiagnostic) {
  $folder=Join-Path $root $Name; [IO.Directory]::CreateDirectory($folder) | Out-Null
  $project=Join-Path $folder 'fixture.csproj'
  [IO.File]::WriteAllText($project,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AssemblyName>LedgeTop.Files.Explorer</AssemblyName></PropertyGroup></Project>')
  [IO.File]::WriteAllText((Join-Path $folder 'NuGet.Config'),'<configuration><packageSources><clear /></packageSources></configuration>')
  $diagnostic=if($IncludeDiagnostic){'internal class DiagnosticConnectionFlags { }'}else{''}
  [IO.File]::WriteAllText((Join-Path $folder 'Fixture.cs'),"namespace LedgeTop.Files.Explorer { public class NativePlaceholderProvider { } $diagnostic }")
  $output=@(& $DotnetPath build $project --configuration Release --nologo --verbosity quiet 2>&1)
  if($LASTEXITCODE -ne 0){throw "Explorer fixture compilation failed: $output"}
  return (Join-Path $folder 'bin\Release\net10.0\LedgeTop.Files.Explorer.dll')
}
$normalExplorer=BuildExplorerFixture 'NormalExplorer' $false
[IO.File]::Copy($normalExplorer,(Join-Path $payload 'LedgeTop.Files.Explorer.dll'))
foreach ($file in @('LedgeTop.Files.exe','LedgeTop.Files.deps.json','LedgeTop.Files.runtimeconfig.json','coreclr.dll','hostfxr.dll','hostpolicy.dll','Notices/LICENSE.cloudflared.txt')) {
  [IO.File]::WriteAllText((Join-Path $payload $file),'Synthetic construction fixture; never execute.')
}
if ((Get-FileHash -LiteralPath $HelperPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2') { throw 'Tests require the already qualified helper bytes, never its execution.' }
Copy-Item -LiteralPath $HelperPath -Destination (Join-Path $payload 'helper/cloudflared.exe')
$inventory = @(Get-ChildItem -LiteralPath $payload -File -Recurse | ForEach-Object {
  [pscustomobject]@{path=[IO.Path]::GetRelativePath($payload,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
} | Sort-Object path)
$inventoryPath=Join-Path $root 'inventory.json'; $receiptPath=Join-Path $root 'build.json'
$build = [ordered]@{status='private_connected_staging_pilot';sourceCommit=$ReviewedCommit;rid='win-x64';selfContained=$true;buildMode='packaged';compiledReleaseChannels=1;channel='pilot';applicationSha256=($inventory | Where-Object path -eq 'LedgeTop.Files.dll').sha256;helperSha256='76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2';payloadFiles=$inventory.Count;payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;cloudflaredIncluded=$true;signed=$false;installerMaintenanceProtocol=1;freshGenerationStagingQualified=$true;sourceArchiveSha256=('0'*64)}
function SaveFixtures { $inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $inventoryPath -Encoding utf8; $build | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
SaveFixtures
# Exercise the exact production snapshot guards without running the script body,
# compiler, app or native maintenance. Reformatting valid JSON must still invalidate
# the byte anchor; the installed sidecar is not a reserialized inventory.
$parseErrors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($builder,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count-ne0){throw 'Builder syntax errors.'}
if ([bool]$ManualStagingAssemblyPath -ne [bool]$PreviousManualStagingAssemblyPath) { throw 'Provide both manual staging assembly paths.' }
$manualPinMutations=[Collections.Generic.List[string]]::new()
if ($ManualStagingAssemblyPath) {
  $guard=$ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'AssertManualStagingAssembly'},$true)
  if (@($guard).Count -ne 1) { throw 'Manual staging assembly guard missing or ambiguous.' }
  . ([scriptblock]::Create($guard.Extent.Text))
  $helperSha='76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
  function CheckManualAssembly([string]$Path) {
    $stream=[IO.File]::OpenRead($Path);$pe=[Reflection.PortableExecutable.PEReader]::new($stream)
    try { $reader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe); AssertManualStagingAssembly $reader $pe }
    finally { $pe.Dispose(); $stream.Dispose() }
  }
  CheckManualAssembly $ManualStagingAssemblyPath
  # Mutate the scope predicate in a task-owned copy to prove a changed body is refused.
  $sourceStream=[IO.File]::OpenRead($ManualStagingAssemblyPath);$sourcePe=[Reflection.PortableExecutable.PEReader]::new($sourceStream)
  try {
    $sourceReader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($sourcePe);$scopeBodies=@()
    foreach($h in $sourceReader.TypeDefinitions){$t=$sourceReader.GetTypeDefinition($h);if($sourceReader.GetString($t.Name) -cne 'FreshGenerationStagingQualification'){continue};foreach($mh in $t.GetMethods()){$m=$sourceReader.GetMethodDefinition($mh);if($sourceReader.GetString($m.Name) -ceq 'Allows'){$body=[Reflection.Metadata.PEReaderExtensions]::GetMethodBody($sourcePe,$m.RelativeVirtualAddress).GetILBytes();if($body.Length -eq 94){$scopeBodies+=,[byte[]]$body}}}}
  } finally { $sourcePe.Dispose();$sourceStream.Dispose() }
  if($scopeBodies.Count -ne 1){throw 'Expected scope method body missing or ambiguous.'}
  $bytes=[IO.File]::ReadAllBytes($ManualStagingAssemblyPath);$hex=[Convert]::ToHexString($bytes);$needle=[Convert]::ToHexString($scopeBodies[0]);$at=$hex.IndexOf($needle,[StringComparison]::Ordinal)
  if($at -lt 0 -or $at % 2 -ne 0 -or $hex.IndexOf($needle,$at+2,[StringComparison]::Ordinal) -ge 0){throw 'Expected scope body bytes not unique.'}
  $bytes[($at / 2)+92]=0x17 # Change the false result to true.
  $changed=Join-Path $root 'ChangedManualScope.dll';[IO.File]::WriteAllBytes($changed,$bytes)
  $rejected=$false
  try { CheckManualAssembly $changed } catch { $rejected=$_.Exception.Message -match 'Manual staging scope instructions differ' }
  if (-not $rejected) { throw 'Changed manual staging scope must be refused.' }
  $manualPinMutations.Add('FreshGenerationStagingQualification.Allows')
  $rejected=$false
  try { CheckManualAssembly $PreviousManualStagingAssemblyPath } catch { $rejected=$_.Exception.Message -match 'Manual staging scope instructions differ' }
  if (-not $rejected) { throw 'The prior manual staging assembly must fail the current frozen scope pin.' }
  # Each separately pinned startup body must still be enforced after a pin refresh.
  # These task-owned PE copies are inspected only; no changed assembly is loaded or executed.
  foreach ($key in @('ReleaseProfiles.For','Startup.Choose','Startup.Choice','Startup..cctor')) {
    $parts=$key.Split('.',2); $stream=[IO.File]::OpenRead($ManualStagingAssemblyPath);$pe=[Reflection.PortableExecutable.PEReader]::new($stream)
    try {
      $reader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe); $bodies=@()
      foreach($th in $reader.TypeDefinitions){$type=$reader.GetTypeDefinition($th);if($reader.GetString($type.Namespace) -cne 'LedgeTop.Files.Backends' -or $reader.GetString($type.Name) -cne $parts[0]){continue}; foreach($mh in $type.GetMethods()){$method=$reader.GetMethodDefinition($mh);if($reader.GetString($method.Name) -ceq $parts[1]){$bodies+=,[byte[]]([Reflection.Metadata.PEReaderExtensions]::GetMethodBody($pe,$method.RelativeVirtualAddress).GetILBytes())}}}
    } finally { $pe.Dispose(); $stream.Dispose() }
    if($bodies.Count -ne 1 -or $bodies[0].Length -eq 0){throw "Expected startup body missing or ambiguous: $key"}
    $bytes=[IO.File]::ReadAllBytes($ManualStagingAssemblyPath);$hex=[Convert]::ToHexString($bytes);$needle=[Convert]::ToHexString($bodies[0]);$at=$hex.IndexOf($needle,[StringComparison]::Ordinal)
    if($at -lt 0 -or $at % 2 -ne 0 -or $hex.IndexOf($needle,$at+2,[StringComparison]::Ordinal) -ge 0){throw "Expected startup body bytes not unique: $key"}
    $index=($at / 2)+$bodies[0].Length-1;$bytes[$index]=$bytes[$index] -bxor 1
    $changed=Join-Path $root ('ChangedStartup-'+$parts[0]+'-'+$parts[1].Replace('.','_')+'.dll');[IO.File]::WriteAllBytes($changed,$bytes)
    $rejected=$false
    try { CheckManualAssembly $changed } catch { $rejected=$_.Exception.Message.Contains("Manual staging startup instructions differ: $key") }
    if(-not $rejected){throw "Changed startup body must be refused: $key"}
    $manualPinMutations.Add($key)
  }
}
$snapshotCases=[Collections.Generic.List[string]]::new()
& {
  foreach($name in @('Hash','Leaf','LocalPath','BoundedJsonBytes','AssertInventoryUnchanged')){
    $function=$ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name
    . ([scriptblock]::Create($function.Extent.Text))
  }
  $PayloadInventoryPath=$inventoryPath
  $manifestBytes=BoundedJsonBytes $inventoryPath 8388608
  $manifestHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant()
  AssertInventoryUnchanged
  $savedHash=$manifestHash;$manifestHash='0'*64;$refused=$false
  try{AssertInventoryUnchanged}catch{$refused=$_.Exception.Message.Contains('changed after verified snapshot')}
  if(-not$refused){throw 'Snapshot wrong-hash refusal failed.'};$snapshotCases.Add('snapshot wrong hash')
  $manifestHash=$savedHash;[IO.File]::AppendAllText($inventoryPath,' ');$refused=$false
  try{AssertInventoryUnchanged}catch{$refused=$_.Exception.Message.Contains('changed after verified snapshot')}
  finally{[IO.File]::WriteAllBytes($inventoryPath,$manifestBytes)}
  if(-not$refused){throw 'Snapshot valid-JSON byte tamper refusal failed.'};$snapshotCases.Add('snapshot changed valid JSON bytes')
}
$base = @{PayloadDirectory=$payload;PayloadInventoryPath=$inventoryPath;BuildReceiptPath=$receiptPath;ReviewedCommit=$ReviewedCommit;AppVersion='0.0.0.5';SourceRepository=$SourceRepository;ValidateOnly=$true;CompilerRoot=(Join-Path $root 'CompilerMustNotBeRead')}
$passed = [Collections.Generic.List[string]]::new()
function Reject([string]$Name,[hashtable]$Changes,[string]$Expected) {
  $candidate=$base.Clone();$candidate.OutputDirectory=Join-Path $root ('Out-'+[Guid]::NewGuid().ToString('N'))
  foreach ($key in $Changes.Keys) { $candidate[$key]=$Changes[$key] }
  $failure=$null
  try { & $builder @candidate | Out-Null } catch { $failure=$_.Exception.Message }
  if ($null -eq $failure -or $failure -notmatch $Expected) { throw "Wrong refusal for ${Name}: $failure" }
  if (Test-Path -LiteralPath $candidate.OutputDirectory) { throw 'Refused input created output or reached compiler.' }
  $passed.Add($Name)
}
$diagExplorer=BuildExplorerFixture 'DiagnosticExplorer' $true
$explorerPath=Join-Path $payload 'LedgeTop.Files.Explorer.dll'; $explorerBackup=Join-Path $root 'GoodExplorer.dll'
[IO.File]::Copy($explorerPath,$explorerBackup)
$explorer=($inventory | Where-Object path -ceq 'LedgeTop.Files.Explorer.dll'); $explorerBytes=$explorer.bytes; $explorerHash=$explorer.sha256
try {
  Copy-Item -LiteralPath $diagExplorer -Destination $explorerPath -Force
  $explorer.bytes=(Get-Item -LiteralPath $explorerPath).Length
  $explorer.sha256=(Get-FileHash -LiteralPath $explorerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum; SaveFixtures
  Reject 'stale prebuilt Explorer with diagnostic connection flags' @{} 'restricted native diagnostic connection flags'
} finally {
  Copy-Item -LiteralPath $explorerBackup -Destination $explorerPath -Force
  $explorer.bytes=$explorerBytes; $explorer.sha256=$explorerHash
  $build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum; SaveFixtures
}
Reject 'application assembly version differs from installer' @{AppVersion='0.0.0.6'} 'assembly version differs from installer version'
# A prebuilt/stale DLL can carry diagnostics despite an ordinary packaged receipt.
$diagAssembly=BuildCoreFixture 'DiagnosticCore' $true
$corePath=Join-Path $payload 'LedgeTop.WindowsDownload.dll'; $coreBackup=Join-Path $root 'GoodCore.dll'
[IO.File]::Copy($corePath,$coreBackup)
$core=($inventory | Where-Object path -ceq 'LedgeTop.WindowsDownload.dll'); $coreBytes=$core.bytes; $coreHash=$core.sha256
$coreGuard=$ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ 'AssertCoreHasNoNativeDiagnostics'
if (@($coreGuard).Count -ne 1) { throw 'Core guard is missing or ambiguous.' }
. ([scriptblock]::Create($coreGuard.Extent.Text))
AssertCoreHasNoNativeDiagnostics $corePath $coreHash
function RefuseCore([string]$Name,[string]$Path,[string]$Hash) {
  $refused=$false
  try { AssertCoreHasNoNativeDiagnostics $Path $Hash } catch { $refused=$true }
  if (-not $refused) { throw "Core guard accepted $Name." }; $passed.Add("Core guard $Name")
}
RefuseCore 'wrong inventory hash' $corePath ('0'*64)
RefuseCore 'missing file' (Join-Path $root 'missing-core.dll') $coreHash
$exclusive=[IO.File]::Open($corePath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try { RefuseCore 'unreadable file' $corePath $coreHash } finally { $exclusive.Dispose() }
RefuseCore 'wrong assembly identity' (Join-Path $payload 'LedgeTop.Files.dll') ((Get-FileHash -LiteralPath (Join-Path $payload 'LedgeTop.Files.dll') -Algorithm SHA256).Hash.ToLowerInvariant())
$candidateCore=BuildCoreFixture 'CandidateCore' $false $true
$ManualStagingTest=$true
try { RefuseCore 'manual experimental candidate' $candidateCore ((Get-FileHash -LiteralPath $candidateCore -Algorithm SHA256).Hash.ToLowerInvariant()) }
finally { $ManualStagingTest=$false }
function UpdateCoreInventory {
  $core.bytes=(Get-Item -LiteralPath $corePath).Length
  $core.sha256=(Get-FileHash -LiteralPath $corePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum; SaveFixtures
}
try {
  Copy-Item -LiteralPath $diagAssembly -Destination $corePath -Force; UpdateCoreInventory
  Reject 'stale prebuilt Core with native tracing despite ordinary receipt' @{} 'restricted native diagnostic tracing'
  [IO.File]::WriteAllBytes($corePath,[byte[]](1,2,3,4)); UpdateCoreInventory
  Reject 'malformed actual Core PE' @{} 'image|metadata|bounds|format|Core assembly'
} finally {
  Copy-Item -LiteralPath $coreBackup -Destination $corePath -Force
  $core.bytes=$coreBytes;$core.sha256=$coreHash;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
}
$inventoryWithCore=$inventory
try {
  [IO.File]::Delete($corePath); $inventory=@($inventory | Where-Object path -cne 'LedgeTop.WindowsDownload.dll')
  $build.payloadFiles=$inventory.Count;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
  Reject 'Core assembly absent from inventory and payload' @{} 'Required self-contained payload file is missing'
} finally {
  [IO.File]::Copy($coreBackup,$corePath);$inventory=$inventoryWithCore
  $build.payloadFiles=$inventory.Count;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
}
Reject 'noncanonical version' @{AppVersion='00.0.0.5'} 'canonical four-component'
Reject 'oversized version' @{AppVersion='0.0.0.65536'} 'canonical four-component'
Reject 'unsafe output alias' @{OutputDirectory=(Join-Path $root 'Out.')} 'Unsafe Windows filename'
foreach ($key in @('status','sourceCommit','rid','buildMode','channel','helperSha256','applicationSha256','sourceArchiveSha256')) {
  $saved=$build[$key]
  $build[$key]=@($saved);SaveFixtures
  Reject "textual ${key} singleton array" @{} 'textual fields must be JSON strings'
  $build[$key]=@{value=$saved};SaveFixtures
  Reject "textual ${key} object" @{} 'textual fields must be JSON strings'
  $build[$key]=$saved;SaveFixtures
}
foreach ($key in @('compiledReleaseChannels','installerMaintenanceProtocol','payloadFiles')) {
  $saved=$build[$key]
  $build[$key]="$saved";SaveFixtures
  Reject "integer ${key} string" @{} 'count/protocol fields must be JSON integers'
  $build[$key]=@($saved);SaveFixtures
  Reject "integer ${key} singleton array" @{} 'count/protocol fields must be JSON integers'
  $build[$key]=@{value=$saved};SaveFixtures
  Reject "integer ${key} object" @{} 'count/protocol fields must be JSON integers'
  $build[$key]=$saved;SaveFixtures
}
$null=$build.Remove('installerMaintenanceProtocol'); SaveFixtures
Reject 'legacy payload protocol absent' @{} 'required construction evidence'
$build.installerMaintenanceProtocol=1; $build.channel='stable';SaveFixtures
Reject 'different channel receipt' @{} 'approved unsigned pilot'
$build.channel='pilot';$build.freshGenerationStagingQualified=$false;SaveFixtures
Reject 'fresh-generation staging qualification is required' @{} 'approved unsigned pilot'
$build.freshGenerationStagingQualified=$true;SaveFixtures
$build.channel='pilot';$build.sourceCommit='0'*40;SaveFixtures
Reject 'different source commit' @{} 'approved unsigned pilot'
$build.sourceCommit=$ReviewedCommit;$build.signed=$true;SaveFixtures
Reject 'signed claim rejected' @{} 'approved unsigned pilot'
$build.signed=$false;$build.payloadFiles++;SaveFixtures
Reject 'wrong receipt count' @{} 'counts or lengths'
$build.payloadFiles--;$build.payloadBytes++;SaveFixtures
Reject 'wrong receipt length' @{} 'counts or lengths'
$build.payloadBytes--;SaveFixtures
$build.installerMaintenanceProtocol='1';SaveFixtures
Reject 'protocol string cannot claim numeric evidence' @{} 'JSON integers'
$build.installerMaintenanceProtocol=1;SaveFixtures
$unqualified=Join-Path $root 'UnqualifiedFreshGeneration.dll';$type='InstallerUnqualifiedFixture'+[Guid]::NewGuid().ToString('N')
Add-Type -OutputAssembly $unqualified -TypeDefinition @"
using System.Reflection;
[assembly:AssemblyMetadata("LedgeTop.ReleaseChannel","pilot")]
[assembly:AssemblyMetadata("LedgeTop.InstallerMaintenanceProtocol","1")]
internal sealed class $type { }
"@
$savedAssembly=Join-Path $root 'QualifiedFixture.dll';Copy-Item -LiteralPath (Join-Path $payload 'LedgeTop.Files.dll') -Destination $savedAssembly
Copy-Item -LiteralPath $unqualified -Destination (Join-Path $payload 'LedgeTop.Files.dll') -Force
$app=($inventory | Where-Object path -eq 'LedgeTop.Files.dll');$oldBytes=$app.bytes;$oldHash=$app.sha256
$app.bytes=(Get-Item (Join-Path $payload 'LedgeTop.Files.dll')).Length;$app.sha256=(Get-FileHash (Join-Path $payload 'LedgeTop.Files.dll')).Hash.ToLowerInvariant()
$build.applicationSha256=$app.sha256;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
Reject 'actual assembly lacks fresh-generation staging qualification' @{} 'staging-qualified pilot'
Copy-Item -LiteralPath $savedAssembly -Destination (Join-Path $payload 'LedgeTop.Files.dll') -Force
$app.bytes=$oldBytes;$app.sha256=$oldHash;$build.applicationSha256=$oldHash;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
$originalPath=$inventory[0].path;$inventory[0].path='../outside';SaveFixtures
Reject 'inventory traversal' @{} 'Unsafe Windows filename'
$inventory[0].path='helper\cloudflared.exe';SaveFixtures
Reject 'raw inventory backslash cannot be normalized under byte anchor' @{} 'canonical forward-slash'
$inventory[0].path='evil$0.txt';SaveFixtures
Reject 'NSIS variable input' @{} 'Unsafe payload relative'
$inventory[0].path='uninstall.exe';SaveFixtures
Reject 'installer filename collision' @{} 'installer-owned'
foreach($reserved in @('installed-payload-inventory.json','INSTALLED-PAYLOAD-INVENTORY.JSON','installed-payload-inventory.json/nested.txt','uninstall.exe/nested.txt','INSTALLER-OWNED.INI/nested.txt')){
  $inventory[0].path=$reserved;SaveFixtures
  Reject "inventory sidecar reserved $reserved" @{} 'installer-owned'
}
$inventory[0].path='CON.txt';SaveFixtures
Reject 'reserved Windows name' @{} 'Unsafe Windows filename'
$inventory[0].path=$originalPath;$hash=$inventory[0].sha256;$inventory[0].sha256='0'*64;SaveFixtures
Reject 'wrong file hash' @{} 'bytes differ'
$inventory[0].sha256=$hash;$length=$inventory[0].bytes;$inventory[0].bytes++;SaveFixtures
Reject 'wrong file length' @{} 'bytes differ'
$inventory[0].bytes=$length
$duplicate=[ordered]@{path=$inventory[0].path.ToUpperInvariant();bytes=$inventory[0].bytes;sha256=$inventory[0].sha256}
$originalInventory=$inventory;$inventory=@($inventory)+@($duplicate);SaveFixtures
Reject 'Windows case duplicate' @{} 'Duplicate/case-colliding'
$inventory=$originalInventory;SaveFixtures
$caseFolder=Join-Path $payload 'A';[IO.Directory]::CreateDirectory($caseFolder)|Out-Null
$extra=@();foreach($leaf in @('one.txt','two.txt')){
  $path=Join-Path $caseFolder $leaf;[IO.File]::WriteAllText($path,'Synthetic case-prefix fixture.')
  $spelling=if($leaf-eq'one.txt'){'A/one.txt'}else{'a/two.txt'}
  $extra+= [pscustomobject]@{path=$spelling;bytes=(Get-Item $path).Length;sha256=(Get-FileHash $path).Hash.ToLowerInvariant()}
}
$inventory=@($inventory)+$extra;$build.payloadFiles=$inventory.Count;$build.payloadBytes=($inventory|Measure-Object bytes -Sum).Sum;SaveFixtures
Reject 'shared directory prefix must have one exact case spelling' @{} 'Case-inconsistent inventory path prefix'
$inventory=$originalInventory;$build.payloadFiles=$inventory.Count;$build.payloadBytes=($inventory|Measure-Object bytes -Sum).Sum;SaveFixtures
foreach($leaf in @('one.txt','two.txt')){[IO.File]::Delete((Join-Path $caseFolder $leaf))};[IO.Directory]::Delete($caseFolder)
[IO.File]::WriteAllText((Join-Path $payload 'unexpected.txt'),'retain')
Reject 'unlisted payload file' @{} 'Unlisted payload file'
[IO.File]::Delete((Join-Path $payload 'unexpected.txt'))
[IO.Directory]::CreateDirectory((Join-Path $payload 'Unexpected empty')) | Out-Null
Reject 'unlisted empty directory' @{} 'Unlisted/empty payload directory'
[IO.Directory]::Delete((Join-Path $payload 'Unexpected empty'))
$junction=Join-Path $payload 'Unexpected link';$linkTarget=Join-Path $root 'LinkTarget'
[IO.Directory]::CreateDirectory($linkTarget) | Out-Null
New-Item -ItemType Junction -Path $junction -Target $linkTarget | Out-Null
try { Reject 'nested directory alias' @{} 'Payload contains an alias' }
finally { if (-not ([IO.Path]::GetFullPath($junction)).StartsWith([IO.Path]::GetFullPath($root)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture link path.' };[IO.Directory]::Delete($junction) }
$sourceAlias=Join-Path $root 'PayloadAlias'
New-Item -ItemType Junction -Path $sourceAlias -Target $payload | Out-Null
try { Reject 'payload source alias' @{PayloadDirectory=$sourceAlias} 'cannot be aliases' }
finally { if (-not ([IO.Path]::GetFullPath($sourceAlias)).StartsWith([IO.Path]::GetFullPath($root)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture link path.' };[IO.Directory]::Delete($sourceAlias) }
$duplicateJson=Join-Path $root 'duplicate.json';[IO.File]::WriteAllText($duplicateJson,'[{"path":"a","path":"b","bytes":0,"sha256":"'+('0'*64)+'"}]')
Reject 'duplicate JSON property' @{PayloadInventoryPath=$duplicateJson} 'Duplicate JSON'
$wrongProtocol = Join-Path $root 'NoProtocol.dll';$type='InstallerOldFixture'+[Guid]::NewGuid().ToString('N')
Add-Type -OutputAssembly $wrongProtocol -TypeDefinition @"
using System.Reflection;
[assembly:AssemblyMetadata("LedgeTop.ReleaseChannel","pilot")]
internal sealed class $type { }
"@
$savedAssembly=Join-Path $root 'GoodProtocol.dll';Copy-Item -LiteralPath (Join-Path $payload 'LedgeTop.Files.dll') -Destination $savedAssembly
Copy-Item -LiteralPath $wrongProtocol -Destination (Join-Path $payload 'LedgeTop.Files.dll') -Force
$app=($inventory | Where-Object path -eq 'LedgeTop.Files.dll');$oldBytes=$app.bytes;$oldHash=$app.sha256
$app.bytes=(Get-Item (Join-Path $payload 'LedgeTop.Files.dll')).Length;$app.sha256=(Get-FileHash (Join-Path $payload 'LedgeTop.Files.dll')).Hash.ToLowerInvariant()
$build.applicationSha256=$app.sha256;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
Reject 'actual assembly lacks maintenance protocol' @{} 'maintenance protocol1 marker'
Copy-Item -LiteralPath $savedAssembly -Destination (Join-Path $payload 'LedgeTop.Files.dll') -Force
$app.bytes=$oldBytes;$app.sha256=$oldHash;$build.applicationSha256=$oldHash;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
$badMode=Join-Path $root 'Developer.dll';$type='InstallerDeveloperFixture'+[Guid]::NewGuid().ToString('N')
Add-Type -OutputAssembly $badMode -TypeDefinition @"
using System.Reflection;
[assembly:AssemblyMetadata("LedgeTop.ReleaseChannel","pilot")]
[assembly:AssemblyMetadata("LedgeTop.InstallerMaintenanceProtocol","1")]
[assembly:AssemblyMetadata("LedgeTop.BuildMode","developer")]
internal sealed class $type { }
"@
Copy-Item -LiteralPath $badMode -Destination (Join-Path $payload 'LedgeTop.Files.dll') -Force
$app.bytes=(Get-Item (Join-Path $payload 'LedgeTop.Files.dll')).Length;$app.sha256=(Get-FileHash (Join-Path $payload 'LedgeTop.Files.dll')).Hash.ToLowerInvariant()
$build.applicationSha256=$app.sha256;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
Reject 'actual assembly developer marker forbidden' @{} 'maintenance protocol1 marker'
Copy-Item -LiteralPath $savedAssembly -Destination (Join-Path $payload 'LedgeTop.Files.dll') -Force
$app.bytes=$oldBytes;$app.sha256=$oldHash;$build.applicationSha256=$oldHash;$build.payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;SaveFixtures
$candidate=$base.Clone();$candidate.OutputDirectory=Join-Path $root 'ValidatedOnly'
$positive=$false;$positiveFailure=$null
try { $result=& $builder @candidate | ConvertFrom-Json; if ($result.status -cne 'unsigned_installer_inputs_validated' -or $result.compilerInvoked -ne $false) { throw 'Wrong validation result.' };$positive=$true }
catch { $positiveFailure=$_.Exception.Message;if ($RequirePositiveValidation -or $positiveFailure -notmatch 'exact reviewed commit') { throw } }
if (Test-Path -LiteralPath $candidate.OutputDirectory) { throw 'ValidateOnly unexpectedly created output.' }
$result=[ordered]@{status='unsigned_installer_refusal_checks_passed';negativeCases=@($passed);negativeCaseCount=$passed.Count;snapshotCases=$snapshotCases.ToArray();manualPinMutations=$manualPinMutations.ToArray();positiveValidation=$positive;positiveHeldReason=$positiveFailure;fixtureRoot=$root;compilerInvoked=$false;executedApplication=$false;installed=$false;uninstalled=$false}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'test-receipt.json') -Encoding utf8
$result | ConvertTo-Json -Depth 4
