param([Parameter(Mandatory)][string]$BuildRoot,[Parameter(Mandatory)][string]$SourceRepository)
$ErrorActionPreference='Stop'
$verifier=Join-Path $PSScriptRoot 'windows-pilot-evidence-verify.ps1'
$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($verifier,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Verifier syntax invalid.'}
$stop=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'StopOwnedArchive'},$true))
if($stop.Count -ne 1){throw 'Archive process supervision helper missing.'};Invoke-Expression $stop[0].Extent.Text
$fake=[pscustomobject]@{Id=12346;Events=[Collections.Generic.List[string]]::new()}
$fake|Add-Member ScriptMethod Kill {param($tree) $this.Events.Add('kill');throw 'Synthetic stop failure.'}
$fake|Add-Member ScriptMethod WaitForExit {param($timeout) if($null -eq $timeout){$this.Events.Add('wait-unbounded');return};$this.Events.Add('wait-bounded');return $false}
StopOwnedArchive $fake
if([string]::Join(',',$fake.Events) -cne 'kill,wait-bounded,wait-unbounded'){throw 'Uncertain archive process was not supervised.'}
$receipt=Get-Content -LiteralPath (Join-Path $BuildRoot 'build-receipt.json') -Raw | ConvertFrom-Json
$base=[ordered]@{schemaVersion=1;sourceCommit=$receipt.sourceCommit;version=$receipt.applicationVersion;
  sourceArchiveSha256=$receipt.sourceArchiveSha256;inventorySha256=$receipt.inventorySha256;applicationSha256=$receipt.applicationSha256;
  receiptSha256=(Get-FileHash -LiteralPath (Join-Path $BuildRoot 'build-receipt.json') -Algorithm SHA256).Hash.ToLowerInvariant();evidence=@()}
$temp=[IO.Path]::GetTempFileName()
try {
  function WriteManifest($value) { $value|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $temp -Encoding utf8 }
  function MustRefuse($value) {
    WriteManifest $value
    try { & $verifier -ManifestPath $temp -BuildRoot $BuildRoot -SourceRepository $SourceRepository | Out-Null }
    catch { return }
    throw 'Verifier accepted a changed or invalid manifest.'
  }
  WriteManifest $base
  $result=& $verifier -ManifestPath $temp -BuildRoot $BuildRoot -SourceRepository $SourceRepository | ConvertFrom-Json
  if($result.status -cne 'byte_consistency_verified_only' -or $result.qualificationVerified -ne $false -or
      $result.installationVerified -ne $false -or $result.liveTransferVerified -ne $false -or $result.installerEligibilityChanged -ne $false){throw 'Verifier overstated its result.'}
  foreach($key in @('sourceArchiveSha256','inventorySha256','applicationSha256','receiptSha256')) {
    $case=@{};foreach($k in $base.Keys){$case[$k]=$base[$k]};$case[$key]='0'*64;MustRefuse $case
  }
  $case=@{};foreach($k in $base.Keys){$case[$k]=$base[$k]};$case.version='0.0.0.6';MustRefuse $case
  $case=@{};foreach($k in $base.Keys){$case[$k]=$base[$k]};$case.schemaVersion='1';MustRefuse $case
  $case=@{};foreach($k in $base.Keys){$case[$k]=$base[$k]};$case.evidence=@(@{classification='approved';path='x';sha256=('0'*64)});MustRefuse $case
  try { & $verifier -ManifestPath 'relative-manifest.json' -BuildRoot $BuildRoot -SourceRepository $SourceRepository | Out-Null; throw 'Relative manifest accepted.' }
  catch { if($_.Exception.Message -notlike '*Manifest must be an absolute local file*'){throw} }
  $alias=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Application Data'
  if ((Test-Path -LiteralPath $alias) -and ((Get-Item -LiteralPath $alias -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    try { & $verifier -ManifestPath (Join-Path $alias 'ignored.json') -BuildRoot $BuildRoot -SourceRepository $SourceRepository | Out-Null; throw 'Reparse manifest ancestor accepted.' }
    catch { if($_.Exception.Message -notlike '*Directory alias refused*'){throw} }
  }
  [IO.File]::WriteAllText($temp,'{"schemaVersion":1,"schemaVersion":1}')
  try { & $verifier -ManifestPath $temp -BuildRoot $BuildRoot -SourceRepository $SourceRepository | Out-Null; throw 'Duplicate JSON was accepted.' }
  catch { if($_.Exception.Message -notlike '*Duplicate JSON key*'){throw} }
  # A tiny independent fixture verifies the actual payload bytes, not only pins.
  $fixture=Join-Path ([IO.Path]::GetTempPath()) ('lt-pilot-evidence-'+[Guid]::NewGuid().ToString('N'))
  $payload=Join-Path $fixture 'payload'; [IO.Directory]::CreateDirectory($payload)|Out-Null
  try {
    [IO.File]::Copy((Join-Path $BuildRoot 'source.zip'),(Join-Path $fixture 'source.zip'))
    $app=Join-Path $payload 'LedgeTop.Files.dll';[IO.File]::WriteAllText($app,'synthetic app bytes')
    $appHash=(Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash.ToLowerInvariant()
    $inv=@(@{path='LedgeTop.Files.dll';bytes=(Get-Item -LiteralPath $app).Length;sha256=$appHash})
    $inv|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $fixture 'payload-inventory.json') -Encoding utf8
    $sample=@{status='connected_payload_unqualified';freshGenerationStagingQualified=$false;sourceAcceptanceVerified=$false;
      installed=$false;published=$false;liveTransferTested=$false;sourceCommit=$base.sourceCommit;applicationVersion=$base.version;
      sourceArchiveSha256=$base.sourceArchiveSha256;inventorySha256=(Get-FileHash -LiteralPath (Join-Path $fixture 'payload-inventory.json') -Algorithm SHA256).Hash.ToLowerInvariant();
      applicationSha256=$appHash;payloadFiles=1;payloadBytes=(Get-Item -LiteralPath $app).Length}
    $sample|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $fixture 'build-receipt.json') -Encoding utf8
    $fixtureManifest=[ordered]@{schemaVersion=1;sourceCommit=$base.sourceCommit;version=$base.version;sourceArchiveSha256=$base.sourceArchiveSha256;
      inventorySha256=$sample.inventorySha256;applicationSha256=$appHash;receiptSha256=(Get-FileHash -LiteralPath (Join-Path $fixture 'build-receipt.json') -Algorithm SHA256).Hash.ToLowerInvariant();evidence=@()}
    $evidencePath=Join-Path $fixture 'synthetic-evidence.txt';[IO.File]::WriteAllText($evidencePath,'synthetic evidence')
    $fixtureManifest.evidence=@(@{classification='synthetic';path='synthetic-evidence.txt';sha256=(Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()})
    WriteManifest $fixtureManifest
    $observed=& $verifier -ManifestPath $temp -BuildRoot $fixture -SourceRepository $SourceRepository | ConvertFrom-Json
    if($observed.evidence[0].classification -cne 'synthetic' -or $observed.evidence[0].interpretation -cne 'unverified supplied evidence; no outcome inferred'){throw 'Evidence classification was overstated.'}
    $sample.installed='false';$sample|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $fixture 'build-receipt.json') -Encoding utf8
    $fixtureManifest.receiptSha256=(Get-FileHash -LiteralPath (Join-Path $fixture 'build-receipt.json') -Algorithm SHA256).Hash.ToLowerInvariant();WriteManifest $fixtureManifest
    try { & $verifier -ManifestPath $temp -BuildRoot $fixture -SourceRepository $SourceRepository | Out-Null;throw 'String boolean was accepted.' }
    catch { if($_.Exception.Message -notlike '*Receipt boolean has an invalid JSON type*'){throw} }
    $sample.installed=$false;$sample|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $fixture 'build-receipt.json') -Encoding utf8
    $fixtureManifest.receiptSha256=(Get-FileHash -LiteralPath (Join-Path $fixture 'build-receipt.json') -Algorithm SHA256).Hash.ToLowerInvariant();WriteManifest $fixtureManifest
    [IO.File]::WriteAllText($evidencePath,'changed evidence')
    try { & $verifier -ManifestPath $temp -BuildRoot $fixture -SourceRepository $SourceRepository | Out-Null;throw 'Changed evidence was accepted.' }
    catch { if($_.Exception.Message -notlike '*Evidence bytes differ*'){throw} }
    [IO.File]::WriteAllText($evidencePath,'synthetic evidence')
    [IO.File]::WriteAllText($app,'mutated app bytes')
    try { & $verifier -ManifestPath $temp -BuildRoot $fixture -SourceRepository $SourceRepository | Out-Null;throw 'Changed payload was accepted.' }
    catch { if($_.Exception.Message -notlike '*Payload differs from inventory*'){throw} }
  } finally {
    foreach($path in @($app,$evidencePath,(Join-Path $fixture 'source.zip'),(Join-Path $fixture 'payload-inventory.json'),(Join-Path $fixture 'build-receipt.json'))) { if($path -and [IO.File]::Exists($path)){[IO.File]::Delete($path)} }
    if([IO.Directory]::Exists($payload)){[IO.Directory]::Delete($payload)}
    if([IO.Directory]::Exists($fixture)){[IO.Directory]::Delete($fixture)}
  }
  Write-Output 'PASS exact pins, mutated pins/version, unsupported classification, duplicate JSON and conservative outcomes.'
} finally { [IO.File]::Delete($temp) }
