param([Parameter(Mandatory)][string]$AssemblyPath)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$builder=Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($builder,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Builder parse failed.'}
$functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'AssertManualStagingAssembly'},$true));if($functions.Count-ne 1){throw 'Guard not found exactly once.'};Invoke-Expression $functions[0].Extent.Text
$helperSha='76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2';Add-Type -AssemblyName System.Reflection.Metadata
function Inspect([string]$path){$stream=[IO.File]::OpenRead($path);$pe=[Reflection.PortableExecutable.PEReader]::new($stream);try{$reader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);AssertManualStagingAssembly $reader $pe}finally{$pe.Dispose();$stream.Dispose()}}
function MethodBodyOffset([string]$path,[string]$typeName,[string]$methodName,[int]$expectedLength){
 $stream=[IO.File]::OpenRead($path);$pe=[Reflection.PortableExecutable.PEReader]::new($stream)
 try {$reader=[Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);$matches=@();foreach($th in $reader.TypeDefinitions){$type=$reader.GetTypeDefinition($th);if($reader.GetString($type.Name)-cne$typeName){continue};foreach($mh in $type.GetMethods()){$method=$reader.GetMethodDefinition($mh);if($reader.GetString($method.Name)-cne$methodName){continue};$body=[Reflection.Metadata.PEReaderExtensions]::GetMethodBody($pe,$method.RelativeVirtualAddress);if($body.GetILBytes().Length-eq$expectedLength){$matches+=@($method.RelativeVirtualAddress)}}}
  if($matches.Count-ne 1){throw 'Target method ambiguous.'};$rva=$matches[0];$sections=@($pe.PEHeaders.SectionHeaders|Where-Object {$rva-ge$_.VirtualAddress -and $rva-lt($_.VirtualAddress+[Math]::Max($_.VirtualSize,$_.SizeOfRawData))});if($sections.Count-ne 1){throw 'Target section ambiguous.'};$offset=[int]($sections[0].PointerToRawData+$rva-$sections[0].VirtualAddress)
  $raw=[IO.File]::ReadAllBytes($path);$head=$raw[$offset];if(($head-band 3)-eq 2){return $offset+1};if(($head-band 3)-eq 3){return $offset+([BitConverter]::ToUInt16($raw,$offset)-shr 12)*4};throw 'Unknown IL header.'
 }finally{$pe.Dispose();$stream.Dispose()}
}
Inspect $AssemblyPath
$targets=@(@('FreshGenerationStagingQualification','Allows',94),@('FreshGenerationStagingQualification','get_UpdaterAvailable',2),@('ReleaseProfiles','For',46),@('Startup','Choose',540),@('Startup','Choice',258),@('Startup','.cctor',21))
$temp=Join-Path ([IO.Path]::GetTempPath()) ('lt-manual-pins-'+[Guid]::NewGuid().ToString('N')+'.dll')
try {foreach($target in $targets){$raw=[IO.File]::ReadAllBytes($AssemblyPath);$offset=MethodBodyOffset $AssemblyPath $target[0] $target[1] $target[2];$raw[$offset]=$raw[$offset]-bxor 1;[IO.File]::WriteAllBytes($temp,$raw);$refused=$false;try{Inspect $temp}catch{$refused=$true};if(-not$refused){throw "Mutated $($target[0]).$($target[1]) was accepted."}}}finally{if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
'PASS exact candidate assembly and six individual frozen-method mutations; metadata only, no app execution.'
