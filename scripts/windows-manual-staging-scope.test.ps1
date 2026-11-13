param([Parameter(Mandatory)][string]$AssemblyPath)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$builder=Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($builder,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Builder syntax invalid.'}
foreach($name in @('AssertReceiptMode','AssertManualStagingAssembly','StopOwnedManualGit')){
 $found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($found.Count -ne 1){throw 'Manual staging test helper missing.'};Invoke-Expression $found[0].Extent.Text
}
$fake=[pscustomobject]@{Id=12347;Events=[Collections.Generic.List[string]]::new()}
$fake|Add-Member ScriptMethod Kill {param($tree) $this.Events.Add('kill');throw 'Synthetic stop failure.'}
$fake|Add-Member ScriptMethod WaitForExit {param($timeout) if($null -eq $timeout){$this.Events.Add('wait-unbounded');return};$this.Events.Add('wait-bounded');return $false}
StopOwnedManualGit $fake
if([string]::Join(',',$fake.Events) -cne 'kill,wait-bounded,wait-unbounded'){throw 'Uncertain manual verifier child was not supervised.'}
function Refuse([scriptblock]$operation){try{& $operation}catch{return};throw 'Unsafe synthetic input accepted.'}
$unqualified=@{status='connected_payload_unqualified';freshGenerationStagingQualified=$false};$qualified=@{status='private_connected_staging_pilot';freshGenerationStagingQualified=$true}
AssertReceiptMode $qualified $false ''
AssertReceiptMode $unqualified $true 'manifest.json'
Refuse {AssertReceiptMode $unqualified $false ''}
Refuse {AssertReceiptMode $unqualified $true ''}
Refuse {AssertReceiptMode $qualified $true 'manifest.json'}
Refuse {AssertReceiptMode $qualified $false 'manifest.json'}
Refuse {AssertReceiptMode @{status='connected_payload_unqualified';freshGenerationStagingQualified='false'} $true 'manifest.json'}
$helperSha='76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
Add-Type -AssemblyName System.Reflection.Metadata
function Inspect([string]$path){
 $stream=[IO.File]::OpenRead($path);$pe=[Reflection.PortableExecutable.PEReader]::new($stream)
 try{$reader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);AssertManualStagingAssembly $reader $pe}finally{$pe.Dispose();$stream.Dispose()}
}
function Location([string]$path,[string]$typeName,[string]$methodName){
 $stream=[IO.File]::OpenRead($path);$pe=[Reflection.PortableExecutable.PEReader]::new($stream)
 try{$reader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);$matches=@();foreach($h in $reader.TypeDefinitions){$type=$reader.GetTypeDefinition($h);if($reader.GetString($type.Name) -ceq $typeName){foreach($mh in $type.GetMethods()){$method=$reader.GetMethodDefinition($mh);if($reader.GetString($method.Name) -ceq $methodName){$matches+=@($method.RelativeVirtualAddress)}}}}
  if($matches.Count -ne 1){throw 'Synthetic target method ambiguous.'};$rva=$matches[0];$section=@($pe.PEHeaders.SectionHeaders|Where-Object {$rva -ge $_.VirtualAddress -and $rva -lt ($_.VirtualAddress+[Math]::Max($_.VirtualSize,$_.SizeOfRawData))});if($section.Count -ne 1){throw 'Section unavailable.'}
  return [int]($section[0].PointerToRawData+$rva-$section[0].VirtualAddress)
 }finally{$pe.Dispose();$stream.Dispose()}
}
function Mutated([string]$source,[string]$typeName,[string]$methodName){
 $raw=[IO.File]::ReadAllBytes($source);$offset=Location $source $typeName $methodName;$head=$raw[$offset]
 if(($head -band 3) -eq 2){$offset++}elseif(($head -band 3) -eq 3){$offset+=([BitConverter]::ToUInt16($raw,$offset) -shr 12)*4}else{throw 'Unknown IL header.'}
 $raw[$offset]=if($raw[$offset] -eq 0x16){0x17}else{0x00};return ,$raw
}
Inspect $AssemblyPath
$temp=Join-Path ([IO.Path]::GetTempPath()) ('LedgeTopManualScopeTest-'+[Guid]::NewGuid().ToString('N')+'.dll')
try{
 [IO.File]::WriteAllBytes($temp,(Mutated $AssemblyPath 'FreshGenerationStagingQualification' 'get_UpdaterAvailable'))
 Refuse {Inspect $temp}
 [IO.File]::WriteAllBytes($temp,(Mutated $AssemblyPath 'Startup' 'Choose'))
 Refuse {Inspect $temp}
 $raw=[IO.File]::ReadAllBytes($AssemblyPath);$needle=[Text.Encoding]::Unicode.GetBytes('https://ops-staging.ledgetopdroneservices.com/api/staff/files');$found=-1
 for($i=0;$i -le $raw.Length-$needle.Length;$i++){if($raw[$i] -ne $needle[0]){continue};$match=$true;for($j=1;$j -lt $needle.Length;$j++){if($raw[$i+$j] -ne $needle[$j]){$match=$false;break}};if($match){$found=$i;break}}
 if($found -lt 0){throw 'Synthetic production-origin mutation fixture unavailable.'}
 $raw[$found+16]=[byte][char]'x';[IO.File]::WriteAllBytes($temp,$raw)
 Refuse {Inspect $temp}
}finally{if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
'PASS explicit/manual receipt separation, updater-on, changed installed startup and changed staging-origin refusal; metadata only, no app execution.'
