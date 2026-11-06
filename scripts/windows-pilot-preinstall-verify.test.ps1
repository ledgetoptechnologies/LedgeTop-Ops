param([Parameter(Mandatory)][string]$SourceRepository,[Parameter(Mandatory)][string]$FixtureSourceZip)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$verifier=Join-Path $PSScriptRoot 'windows-pilot-preinstall-verify.ps1'
$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($verifier,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Verifier has syntax errors.'}
$stop=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'StopTimedOutGit'},$true))
if($stop.Count -ne 1){throw 'Owned process supervision helper missing.'};Invoke-Expression $stop[0].Extent.Text
$fake=[pscustomobject]@{Id=12345;Events=[Collections.Generic.List[string]]::new()}
$fake|Add-Member ScriptMethod Kill {param($tree) $this.Events.Add('kill');throw 'Synthetic stop failure.'}
$fake|Add-Member ScriptMethod WaitForExit {param($timeout) if($null -eq $timeout){$this.Events.Add('wait-unbounded');return};$this.Events.Add('wait-bounded');return $false}
StopTimedOutGit $fake
if([string]::Join(',',$fake.Events) -cne 'kill,wait-bounded,wait-unbounded'){throw 'Uncertain child was not supervised to exit.'}
$root=Join-Path ([IO.Path]::GetTempPath()) ('lt-preinstall-verifier-test-'+[Guid]::NewGuid().ToString('N'))
$payload=Join-Path $root 'payload';$reviews=Join-Path $root 'reviews';[IO.Directory]::CreateDirectory($payload)|Out-Null;[IO.Directory]::CreateDirectory($reviews)|Out-Null
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function WriteJson([string]$path,$value){$value|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $path -Encoding utf8}
try {
 $commit='183433c79a43d2cf4adb8f7bd6c0bd538d680bde';$tree='ac4674db0d6bb52b8c9b0308b53f82214ce826c9';$version='0.0.0.5'
 [IO.File]::Copy($FixtureSourceZip,(Join-Path $root 'source.zip'))
 $app=Join-Path $payload 'LedgeTop.Files.dll';[IO.File]::WriteAllText($app,'synthetic app')
 $appHash=Hash $app;$inventoryPath=Join-Path $root 'payload-inventory.json'
 ,@(@{path='LedgeTop.Files.dll';bytes=(Get-Item -LiteralPath $app).Length;sha256=$appHash})|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $inventoryPath -Encoding utf8
 $receipt=[ordered]@{status='connected_payload_unqualified';sourceCommit=$commit;sourceTree=$tree;applicationVersion=$version;
  sourceArchiveSha256=Hash (Join-Path $root 'source.zip');inventorySha256=Hash $inventoryPath;applicationSha256=$appHash;
  freshGenerationStagingQualified=$false;sourceAcceptanceVerified=$false;installed=$false;published=$false;liveTransferTested=$false;
  payloadFiles=1;payloadBytes=(Get-Item -LiteralPath $app).Length;builderSha256=('1'*64);dotnetSha256=('2'*64);helperSha256=('3'*64);sdk='10.0.402';restoreSource='synthetic-source'}
 $receiptPath=Join-Path $root 'build-receipt.json';WriteJson $receiptPath $receipt
 $testLog=Join-Path $root 'test-log.txt';[IO.File]::WriteAllText($testLog,'SYNTHETIC TEST FIXTURE; NO ACTUAL PASS CLAIM')
 $base=[ordered]@{schemaVersion=1;sourceCommit=$commit;version=$version;sourceArchiveSha256=$receipt.sourceArchiveSha256;inventorySha256=$receipt.inventorySha256;
  applicationSha256=$appHash;receiptSha256=Hash $receiptPath;evidence=@(@{classification='synthetic';path='test-log.txt';sha256=Hash $testLog})}
 $basePath=Join-Path $root 'base.json';WriteJson $basePath $base
 $entries=@();foreach($pair in @(@('source-scope','Reviewer One'),@('safety-and-tests','Reviewer Two'))){
  $kind=$pair[0];$reviewer=$pair[1];$file=$kind+'.json'
  $record=[ordered]@{kind=$kind;reviewer=$reviewer;result='pass';findings='Synthetic fixture, no review occurred.';sourceCommit=$commit;sourceTree=$tree;sourceArchiveSha256=$base.sourceArchiveSha256;
   version=$version;receiptSha256=$base.receiptSha256;inventorySha256=$base.inventorySha256;applicationSha256=$base.applicationSha256;
   builderSha256=$receipt.builderSha256;dotnetSha256=$receipt.dotnetSha256;helperSha256=$receipt.helperSha256;sdk=$receipt.sdk;
   restoreSource=$receipt.restoreSource;syntheticTestEvidenceSha256=Hash $testLog}
  WriteJson (Join-Path $reviews $file) $record
  $entries+=@{kind=$kind;reviewer=$reviewer;file=$file;sha256=Hash (Join-Path $reviews $file)}
 }
 $reviewManifest=[ordered]@{schemaVersion=1;baseManifestSha256=Hash $basePath;sourceTree=$tree;builderIdentity='Builder One';reviews=$entries}
 $reviewManifestPath=Join-Path $root 'review-manifest.json';WriteJson $reviewManifestPath $reviewManifest
 function Run(){ & $verifier -ManifestPath $basePath -ReviewManifestPath $reviewManifestPath -ReviewDirectory $reviews -BuildRoot $root -SourceRepository $SourceRepository | ConvertFrom-Json -AsHashtable }
 $result=Run
 if($result.status -cne 'preinstall_evidence_structure_checked' -or $result.qualificationVerified -ne $false -or $result.reviewIdentityAuthenticated -ne $false -or $result.installerEligibilityChanged -ne $false -or $result.liveTransferTested -ne $false){throw 'Verifier overstated evidence.'}
 function Reject(){try{Run|Out-Null}catch{return};throw 'Mutation was accepted.'}
 $reviewManifest.reviews[1].reviewer='Reviewer One';WriteJson $reviewManifestPath $reviewManifest;Reject
 $reviewManifest.reviews[1].reviewer='Reviewer Two';$reviewManifest.sourceTree='0'*40;WriteJson $reviewManifestPath $reviewManifest;Reject
 $reviewManifest.sourceTree=$tree;WriteJson $reviewManifestPath $reviewManifest
 $recordPath=Join-Path $reviews 'safety-and-tests.json';$saved=[IO.File]::ReadAllBytes($recordPath)
 $bad=Get-Content -LiteralPath $recordPath -Raw|ConvertFrom-Json -AsHashtable;$bad.version='0.0.0.6';WriteJson $recordPath $bad
 $reviewManifest.reviews[1].sha256=Hash $recordPath;WriteJson $reviewManifestPath $reviewManifest;Reject
 [IO.File]::WriteAllBytes($recordPath,$saved);$reviewManifest.reviews[1].sha256=Hash $recordPath;WriteJson $reviewManifestPath $reviewManifest
 [IO.File]::AppendAllText((Join-Path $reviews 'source-scope.json'),' ');Reject
 Write-Output 'PASS synthetic exact pins, independent-review labels, mutations and conservative non-approval result.'
} finally {
 # Only this exact synthetic fixture, created above, contains no live user data.
 $actual=[IO.Path]::GetFullPath($root);if(-not $actual.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($actual).StartsWith('lt-preinstall-verifier-test-')){throw 'Fixture cleanup target differs.'}
 $children=@(Get-ChildItem -LiteralPath $root -Recurse -Force);foreach($child in $children){if(-not $child.FullName.StartsWith($actual+'\',[StringComparison]::OrdinalIgnoreCase) -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixture cleanup child differs.'}}
 foreach($file in @($children|Where-Object {-not $_.PSIsContainer})){[IO.File]::Delete($file.FullName)}
 foreach($dir in @($children|Where-Object {$_.PSIsContainer}|Sort-Object {$_.FullName.Length} -Descending)){[IO.Directory]::Delete($dir.FullName)}
 [IO.Directory]::Delete($root)
}
