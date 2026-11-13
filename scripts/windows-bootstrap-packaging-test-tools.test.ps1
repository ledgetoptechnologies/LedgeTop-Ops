param(
 [Parameter(Mandatory)][string]$OutputRoot,
 [Parameter(Mandatory)][string]$SourceArchivePath,
 [Parameter(Mandatory)][string]$HelperPath,
 [Parameter(Mandatory)][string]$HelperLicensePath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not[IO.Path]::IsPathFullyQualified($OutputRoot)-or(Test-Path -LiteralPath $OutputRoot)){throw 'Use a new absolute test directory.'}
[IO.Directory]::CreateDirectory($OutputRoot)|Out-Null
$bootstrap=Join-Path $PSScriptRoot 'windows-bootstrap-packaging-test-tools.ps1'
$base=@{SourceArchivePath=$SourceArchivePath;HelperPath=$HelperPath;HelperLicensePath=$HelperLicensePath}
$passed=[Collections.Generic.List[string]]::new()
function Refuses([string]$name,[hashtable]$changes,[string]$expected=''){
 $out=Join-Path $OutputRoot $name;$arguments=$base.Clone();$arguments.OutputDirectory=$out
 foreach($key in $changes.Keys){$arguments[$key]=$changes[$key]}
 $failed=$false;$message='';try{& $bootstrap @arguments|Out-Null}catch{$failed=$true;$message=$_.Exception.Message}
 if(-not$failed-or(Test-Path -LiteralPath $out)-or($expected-and-not$message.Contains($expected))){throw "Tool bootstrap refusal failed: $name"}
 $passed.Add($name)
}
$invalid=Join-Path $OutputRoot 'invalid.bin';[IO.File]::WriteAllText($invalid,'Synthetic invalid public tool; never execute.')
Refuses 'relative-output' @{OutputDirectory='relative'}
Refuses 'unc-output' @{OutputDirectory='\\synthetic.invalid\never-access'}
Refuses 'partial-offline-inputs' @{HelperLicensePath=''}
Refuses 'missing-archive' @{SourceArchivePath=(Join-Path $OutputRoot 'absent.zip')}
Refuses 'tampered-archive' @{SourceArchivePath=$invalid}
Refuses 'tampered-helper' @{HelperPath=$invalid}
Refuses 'tampered-license' @{HelperLicensePath=$invalid}
# Keep the helper length correct while corrupting one byte: SHA, not length, must refuse.
$changed=Join-Path $OutputRoot 'same-size-helper.bin';[IO.File]::Copy($HelperPath,$changed)
$stream=[IO.File]::Open($changed,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite);try{$first=$stream.ReadByte();$stream.Position=0;$stream.WriteByte($first-bxor1)}finally{$stream.Dispose()}
Refuses 'same-size-changed-helper' @{HelperPath=$changed}
$existing=Join-Path $OutputRoot 'existing';[IO.Directory]::CreateDirectory($existing)|Out-Null;$marker=Join-Path $existing 'retained.txt';[IO.File]::WriteAllText($marker,'retained')
$failed=$false;try{& $bootstrap @base -OutputDirectory $existing|Out-Null}catch{$failed=$true}
if(-not$failed-or[IO.File]::ReadAllText($marker)-cne'retained'){throw 'Existing tool folder changed.'};$passed.Add('existing-output-preserved')
$target=Join-Path $OutputRoot 'ordinary';[IO.Directory]::CreateDirectory($target)|Out-Null;[IO.File]::Copy($HelperLicensePath,(Join-Path $target 'license.txt'))
$alias=Join-Path $OutputRoot 'alias';New-Item -ItemType Junction -Path $alias -Target $target|Out-Null
Refuses 'aliased-input' @{HelperLicensePath=(Join-Path $alias 'license.txt')} 'aliases'
Refuses 'aliased-output-parent' @{OutputDirectory=(Join-Path $alias 'new-output')} 'aliases'
$out=Join-Path $OutputRoot 'positive'
$receipt=& $bootstrap @base -OutputDirectory $out|ConvertFrom-Json
if($receipt.downloaded-or-not$receipt.helperSignatureValid-or$receipt.nsisEntries-ne441-or$receipt.compilerExecuted-or$receipt.helperExecuted-or$receipt.installerExecuted-or$receipt.globalSettingsChanged){throw 'Tool bootstrap positive receipt differs.'}
$zip=[IO.Compression.ZipFile]::OpenRead($SourceArchivePath);$files=0
try{foreach($entry in $zip.Entries){if(-not$entry.FullName.EndsWith('/')){
 $stream=$entry.Open();try{$sha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()}finally{$stream.Dispose()}
 $actual=Join-Path $out ('toolchain/'+$entry.FullName)
 if((Get-FileHash -LiteralPath $actual).Hash.ToLowerInvariant()-cne$sha){throw 'Full extracted toolchain verification failed.'};$files++
}}}finally{$zip.Dispose()}
if(@(Get-ChildItem -LiteralPath (Join-Path $out 'toolchain') -File -Recurse).Count-ne$files){throw 'Unexpected extracted tool file.'}
$passed.Add('all-extracted-files-and-signature-positive')
[ordered]@{testsPassed=$passed.Count;cases=$passed.ToArray();networkUsed=$false;compilerExecuted=$false;helperExecuted=$false;installerExecuted=$false;receiptPath=(Join-Path $out 'receipt.json')}|ConvertTo-Json -Depth 4