param(
  [Parameter(Mandatory)][string]$HelperPath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [string]$SourceRepository = ([IO.Path]::GetDirectoryName($PSScriptRoot)),
  [switch]$RequirePositiveValidation
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
[assembly:AssemblyMetadata("LedgeTop.ReleaseChannel","pilot")]
[assembly:AssemblyMetadata("LedgeTop.InstallerMaintenanceProtocol","1")]
internal sealed class $type { }
"@
foreach ($file in @('LedgeTop.Files.exe','LedgeTop.Files.deps.json','LedgeTop.Files.runtimeconfig.json','coreclr.dll','hostfxr.dll','hostpolicy.dll','Notices/LICENSE.cloudflared.txt')) {
  [IO.File]::WriteAllText((Join-Path $payload $file),'Synthetic construction fixture; never execute.')
}
if ((Get-FileHash -LiteralPath $HelperPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2') { throw 'Tests require the already qualified helper bytes, never its execution.' }
Copy-Item -LiteralPath $HelperPath -Destination (Join-Path $payload 'helper/cloudflared.exe')
$inventory = @(Get-ChildItem -LiteralPath $payload -File -Recurse | ForEach-Object {
  [pscustomobject]@{path=[IO.Path]::GetRelativePath($payload,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
} | Sort-Object path)
$inventoryPath=Join-Path $root 'inventory.json'; $receiptPath=Join-Path $root 'build.json'
$build = [ordered]@{status='private_connected_staging_pilot';sourceCommit=$ReviewedCommit;rid='win-x64';selfContained=$true;buildMode='packaged';compiledReleaseChannels=1;channel='pilot';applicationSha256=($inventory | Where-Object path -eq 'LedgeTop.Files.dll').sha256;helperSha256='76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2';payloadFiles=$inventory.Count;payloadBytes=($inventory | Measure-Object bytes -Sum).Sum;cloudflaredIncluded=$true;signed=$false;installerMaintenanceProtocol=1;sourceArchiveSha256=('0'*64)}
function SaveFixtures { $inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $inventoryPath -Encoding utf8; $build | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
SaveFixtures
# Exercise the exact production snapshot guards without running the script body,
# compiler, app or native maintenance. Reformatting valid JSON must still invalidate
# the byte anchor; the installed sidecar is not a reserialized inventory.
$parseErrors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($builder,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count-ne0){throw 'Builder syntax errors.'}
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
$result=[ordered]@{status='unsigned_installer_refusal_checks_passed';negativeCases=@($passed);negativeCaseCount=$passed.Count;snapshotCases=$snapshotCases.ToArray();positiveValidation=$positive;positiveHeldReason=$positiveFailure;fixtureRoot=$root;compilerInvoked=$false;executedApplication=$false;installed=$false;uninstalled=$false}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'test-receipt.json') -Encoding utf8
$result | ConvertTo-Json -Depth 4
