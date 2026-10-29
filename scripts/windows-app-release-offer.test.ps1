param(
  [Parameter(Mandatory)][string]$InstallerDirectory,
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$ArtifactRoot,
  [string]$SourceRepository=([IO.Path]::GetDirectoryName($PSScriptRoot))
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$producer=Join-Path $PSScriptRoot 'windows-app-release-offer.ps1'
$run=Join-Path $ArtifactRoot ('tests-'+[Guid]::NewGuid().ToString('N'))
if(-not [IO.Directory]::Exists($ArtifactRoot)){throw 'Create the single approved release-offer artifact parent first.'}
[IO.Directory]::CreateDirectory($run)|Out-Null
$installerReceipt=Join-Path $InstallerDirectory 'installer-build-receipt.json'
$original=Get-Content -LiteralPath $installerReceipt -Raw
$receipt=$original|ConvertFrom-Json -AsHashtable
$base=@{InstallerReceiptPath=$installerReceipt;InstallerPath=(Join-Path $InstallerDirectory ('LedgeTop-Files-Pilot-'+$receipt.appVersion+'-unsigned-setup.exe'));
 PayloadAssemblyPath=(Join-Path $PayloadDirectory 'app/LedgeTop.Files.dll');PayloadBuildReceiptPath=(Join-Path $PayloadDirectory 'build-receipt.json');PayloadInventoryPath=(Join-Path $PayloadDirectory 'payload-inventory.json');ApprovedChannel='pilot';SiteKind='operations';SourceRepository=$SourceRepository}
$passed=[Collections.Generic.List[string]]::new()
function Write-Json([string]$path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
function Reject([string]$name,[hashtable]$overrides){
 $arguments=$base.Clone();foreach($key in $overrides.Keys){$arguments[$key]=$overrides[$key]};$output=Join-Path $run ($name+'.json');$arguments.OutputPath=$output
 $failed=$false;try{$null=& $producer @arguments}catch{$failed=$true}
 if(-not$failed-or[IO.File]::Exists($output)-or[IO.File]::Exists($output+'.construction-receipt.json')){throw "Negative case did not reject without output: $name"}
 $passed.Add($name)
}
foreach($site in @('operations','portal')){
 $arguments=$base.Clone();$arguments.SiteKind=$site;$arguments.OutputPath=Join-Path $run ($site+'-actual.json')
 $null=& $producer @arguments
 $offer=Get-Content -LiteralPath $arguments.OutputPath -Raw|ConvertFrom-Json -AsHashtable
 $sidecar=Get-Content -LiteralPath ($arguments.OutputPath+'.construction-receipt.json') -Raw|ConvertFrom-Json -AsHashtable
 $prefix=if($site-eq'operations'){'/api/app'}else{'/api/client/app'}
 if($offer.downloadUrl-cne($prefix+'/download/'+$receipt.appVersion+'?platform=windows&channel=pilot')-or$offer.strongETag-cne('"sha256-'+$receipt.installerSha256+'"')-or$offer.sizeBytes-ne$receipt.installerBytes-or
    $offer.sourceCommit-cne$receipt.sourceCommit-or$offer.installerType-cne'exe'-or$offer.schemaVersion-ne1-or$sidecar.observedApplication.assemblyVersion-cne$receipt.appVersion-or
    $sidecar.published-or$sidecar.endpointImplemented-or$sidecar.publisherApprovalProven-or$sidecar.signatureTrustVerified-or$sidecar.serverStrongETagObserved){throw 'Actual positive offer contract differs.'}
 $passed.Add($site+'-actual-bytes')
}
$mutations=@(
 @{Name='channel-array';Key='channel';Value=@('pilot')},@{Name='channel-wrong';Key='channel';Value='stable'},
 @{Name='protocol-array';Key='installerMaintenanceProtocol';Value=@(1)},@{Name='protocol-wrong';Key='installerMaintenanceProtocol';Value=2},
 @{Name='schema-double';Key='schemaVersion';Value=1.0},@{Name='length-array';Key='installerBytes';Value=@($receipt.installerBytes)},
 @{Name='length-wrong';Key='installerBytes';Value=1},@{Name='hash-wrong';Key='installerSha256';Value=('0'*64)},
 @{Name='application-hash-wrong';Key='applicationSha256';Value=('0'*64)},@{Name='version-observation-mismatch';Key='appVersion';Value='0.5.2.0'},
 @{Name='version-leadingzero';Key='appVersion';Value='00.5.1.0'},@{Name='template-blob-wrong';Key='templateBlob';Value=('f'*40)},
 @{Name='template-hash-wrong';Key='templateSha256';Value=('0'*64)},@{Name='builder-hash-wrong';Key='builderSha256';Value=('0'*64)},
 @{Name='inventory-hash-wrong';Key='payloadInventorySha256';Value=('0'*64)},@{Name='build-hash-wrong';Key='buildReceiptSha256';Value=('0'*64)},
 @{Name='source-archive-wrong';Key='sourceArchiveSha256';Value=('0'*64)},@{Name='signed-claim';Key='signed';Value=$true},
 @{Name='published-claim';Key='published';Value=$true},@{Name='developer-build';Key='buildMode';Value='developer'}
)
foreach($mutation in $mutations){$copy=$original|ConvertFrom-Json -AsHashtable;$copy[$mutation.Key]=$mutation.Value;$path=Join-Path $run ($mutation.Name+'-receipt.json');Write-Json $path $copy;Reject $mutation.Name @{InstallerReceiptPath=$path}}
foreach($pair in @(@{Name='html-notes';Value='<script>x</script>'},@{Name='link-notes';Value='https://foreign.invalid/app'},@{Name='control-notes';Value="line`nnext"},@{Name='long-notes';Value=('a'*601)})){Reject $pair.Name @{Notes=$pair.Value}}
Reject 'uppercase-site' @{SiteKind='OPERATIONS'}
Reject 'unapproved-channel' @{ApprovedChannel='stable'}
$tiny=Join-Path $run 'wrong-installer.exe';[IO.File]::WriteAllBytes($tiny,[byte[]]@(77,90,0,0));Reject 'actual-installer-mismatch' @{InstallerPath=$tiny}
foreach($case in @(@{Name='duplicate-json';Extra='channel'},@{Name='case-ambiguous-json';Extra='Channel'})){
 $path=Join-Path $run ($case.Name+'-receipt.json');$raw=$original.Replace('"channel": "pilot"',('"channel": "pilot", "'+$case.Extra+'": "pilot"'))
 if($raw-ceq$original){throw 'Duplicate JSON test fixture did not mutate.'};[IO.File]::WriteAllText($path,$raw);Reject $case.Name @{InstallerReceiptPath=$path}
}
$arrayReceipt=Join-Path $run 'singleton-root-array-receipt.json';[IO.File]::WriteAllText($arrayReceipt,('['+$original+']'));Reject 'singleton-root-array' @{InstallerReceiptPath=$arrayReceipt}
$wrongAssemblyDirectory=Join-Path $run 'wrong-assembly';[IO.Directory]::CreateDirectory($wrongAssemblyDirectory)|Out-Null
$wrongAssembly=Join-Path $wrongAssemblyDirectory 'LedgeTop.Files.dll';[IO.File]::Copy((Join-Path $PayloadDirectory 'app/LedgeTop.WindowsDownload.dll'),$wrongAssembly,$false)
$copy=$original|ConvertFrom-Json -AsHashtable;$copy.applicationSha256=(Get-FileHash -LiteralPath $wrongAssembly).Hash.ToLowerInvariant();$forgedReceipt=Join-Path $run 'wrong-actual-assembly-receipt.json';Write-Json $forgedReceipt $copy
Reject 'rehash-does-not-authorize-wrong-actual-pe-metadata' @{InstallerReceiptPath=$forgedReceipt;PayloadAssemblyPath=$wrongAssembly}
# Even if a caller rehashes forged JSON receipts, actual guard observations must refuse it.
$badBuild=Get-Content -LiteralPath $base.PayloadBuildReceiptPath -Raw|ConvertFrom-Json -AsHashtable;$badBuild.status=@('private_connected_staging_pilot')
$badBuildPath=Join-Path $run 'forged-build-array.json';Write-Json $badBuildPath $badBuild
$copy=$original|ConvertFrom-Json -AsHashtable;$copy.buildReceiptSha256=(Get-FileHash -LiteralPath $badBuildPath).Hash.ToLowerInvariant();$forgedReceipt=Join-Path $run 'forged-build-receipt.json';Write-Json $forgedReceipt $copy
Reject 'rehash-does-not-authorize-typed-array' @{InstallerReceiptPath=$forgedReceipt;PayloadBuildReceiptPath=$badBuildPath}
$badInventory=@(Get-Content -LiteralPath $base.PayloadInventoryPath -Raw|ConvertFrom-Json -AsHashtable);$badInventory[0].bytes++
$badInventoryPath=Join-Path $run 'forged-inventory.json';Write-Json $badInventoryPath $badInventory
$copy=$original|ConvertFrom-Json -AsHashtable;$copy.payloadInventorySha256=(Get-FileHash -LiteralPath $badInventoryPath).Hash.ToLowerInvariant();$forgedReceipt=Join-Path $run 'forged-inventory-receipt.json';Write-Json $forgedReceipt $copy
Reject 'rehash-does-not-authorize-wrong-payload-length' @{InstallerReceiptPath=$forgedReceipt;PayloadInventoryPath=$badInventoryPath}
foreach($collision in @('offer','sidecar')){
 $output=Join-Path $run ('immutable-'+$collision+'.json');$existing=if($collision-eq'offer'){$output}else{$output+'.construction-receipt.json'}
 [IO.File]::WriteAllText($existing,'existing immutable bytes');$arguments=$base.Clone();$arguments.OutputPath=$output;$failed=$false;try{$null=& $producer @arguments}catch{$failed=$true}
 if(-not$failed-or[IO.File]::ReadAllText($existing)-cne'existing immutable bytes'){throw 'Existing output was changed.'};if($collision-eq'sidecar'-and[IO.File]::Exists($output)){throw 'Sidecar collision left an offer.'};$passed.Add('immutable-'+$collision)
}
$summary=@{schemaVersion=1;testsPassed=$passed.Count;cases=@($passed.ToArray());realApplicationExecuted=$false;installerExecuted=$false;networkUsed=$false;published=$false;artifactDirectory=$run}
Write-Json (Join-Path $run 'test-receipt.json') $summary
$summary|ConvertTo-Json -Depth 4
