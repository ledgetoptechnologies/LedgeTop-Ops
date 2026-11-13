param([Parameter(Mandatory)][string]$SourceRepository,[Parameter(Mandatory)][string]$ReviewedCommit)
$ErrorActionPreference='Stop'
if($ReviewedCommit -cnotmatch '\A[0-9a-f]{40}\z'){throw 'Exact commit required.'}
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function RemoveVerifiedFixture([string]$root,[string]$archive) {
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if([IO.Path]::GetDirectoryName($root) -cne $temp -or [IO.Path]::GetFileName($root) -cnotmatch '\Alt-pilot-archive-closure-[0-9a-f]{32}\z'){throw 'Fixture root is outside the owned temporary location.'}
  $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  function AddExpected([string]$path) {
    $path=$path.TrimEnd('/')
    while($path){$null=$expected.Add($path);$slash=$path.LastIndexOf('/');if($slash -lt 0){break};$path=$path.Substring(0,$slash)}
  }
  foreach($path in @('source.zip','payload/LedgeTop.Files.dll','payload-inventory.json','build-receipt.json','manifest.json')){AddExpected $path}
  $zip=[IO.Compression.ZipFile]::OpenRead($archive)
  try {foreach($entry in $zip.Entries){AddExpected ('source/'+$entry.FullName)}} finally {$zip.Dispose()}
  $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root)
  while($pending.Count){
    $folder=$pending.Pop()
    if(([IO.File]::GetAttributes($folder) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Fixture directory changed to an alias.'}
    foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($folder)){
      $attributes=[IO.File]::GetAttributes($entry)
      if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Fixture contains an alias.'}
      $relative=[IO.Path]::GetRelativePath($root,$entry).Replace('\','/')
      if(-not $expected.Remove($relative)){throw 'Fixture contains an unexpected entry.'}
      if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){$pending.Push($entry)}
    }
  }
  if($expected.Count -ne 0){throw 'Fixture entries changed before cleanup.'}
  [IO.Directory]::Delete($root,$true)
}
# Derive the builder's actual literal archive pathspec; fail if either script
# stops using the expected explicit, reviewable syntax.
$builder=& git -C $SourceRepository show "${ReviewedCommit}:scripts/windows-connected-pilot-payload.ps1"
if($LASTEXITCODE -ne 0){throw 'Builder source unavailable.'}
$line=@($builder | Where-Object {$_ -match '^& git -C \$SourceRepository archive --format=zip '})
if($line.Count -ne 1 -or $line[0] -cnotmatch '\$ReviewedCommit -- (.+)$'){throw 'Unexpected builder archive command.'}
$paths=@($Matches[1].Split(' ',[StringSplitOptions]::RemoveEmptyEntries))
if($paths -cnotcontains 'scripts/windows-pilot-evidence-verify.ps1' -or $paths -cnotcontains 'scripts/windows-unsigned-installer.ps1'){throw 'Manual installer sibling scripts missing from archive selection.'}
$root=Join-Path ([IO.Path]::GetTempPath()) ('lt-pilot-archive-closure-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
try {
  $archive=Join-Path $root 'source.zip'
  & git -C $SourceRepository archive --format=zip "--output=$archive" $ReviewedCommit -- @paths
  if($LASTEXITCODE -ne 0){throw 'Synthetic archive failed.'}
  $source=Join-Path $root 'source';[IO.Compression.ZipFile]::ExtractToDirectory($archive,$source)
  $guard=Join-Path $source 'scripts/windows-unsigned-installer.ps1'
  $verifier=Join-Path $source 'scripts/windows-pilot-evidence-verify.ps1'
  if(-not [IO.File]::Exists($guard) -or -not [IO.File]::Exists($verifier)){throw 'Archived installer sibling absent.'}
  if((Get-Content -LiteralPath $guard -Raw) -cnotmatch 'Join-Path \x24PSScriptRoot ''windows-pilot-evidence-verify\.ps1'''){throw 'Installer sibling contract changed; review this test.'}
  $blob=& git -C $SourceRepository rev-parse "${ReviewedCommit}:scripts/windows-pilot-evidence-verify.ps1"
  $actual=& git hash-object --no-filters -- $verifier
  if($LASTEXITCODE -ne 0 -or $actual -cne $blob){throw 'Archived verifier does not match reviewed commit.'}
  $payload=Join-Path $root 'payload';[IO.Directory]::CreateDirectory($payload)|Out-Null
  $app=Join-Path $payload 'LedgeTop.Files.dll';[IO.File]::WriteAllText($app,'synthetic bytes')
  $appHash=Hash $app;$archiveHash=Hash $archive;$size=(Get-Item -LiteralPath $app).Length
  $inventory=Join-Path $root 'payload-inventory.json'
  ConvertTo-Json -InputObject @(@{path='LedgeTop.Files.dll';bytes=$size;sha256=$appHash}) -Depth 5 | Set-Content -LiteralPath $inventory -Encoding utf8
  $receipt=Join-Path $root 'build-receipt.json'
  @{status='connected_payload_unqualified';freshGenerationStagingQualified=$false;sourceAcceptanceVerified=$false;installed=$false;published=$false;liveTransferTested=$false;sourceCommit=$ReviewedCommit;applicationVersion='0.0.0.5';sourceArchiveSha256=$archiveHash;inventorySha256=(Hash $inventory);applicationSha256=$appHash;payloadFiles=1;payloadBytes=$size}|ConvertTo-Json|Set-Content -LiteralPath $receipt -Encoding utf8
  $manifest=Join-Path $root 'manifest.json'
  @{schemaVersion=1;sourceCommit=$ReviewedCommit;version='0.0.0.5';sourceArchiveSha256=$archiveHash;inventorySha256=(Hash $inventory);applicationSha256=$appHash;receiptSha256=(Hash $receipt);evidence=@()}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $manifest -Encoding utf8
  # The archived verifier deliberately needs the explicit real Git repository.
  $result=& $verifier -ManifestPath $manifest -BuildRoot $root -SourceRepository $SourceRepository | ConvertFrom-Json
  if($result.status -cne 'byte_consistency_verified_only' -or $result.qualificationVerified -ne $false -or $result.installerEligibilityChanged -ne $false){throw 'Archived verifier overstated synthetic evidence.'}
  RemoveVerifiedFixture $root $archive
  Write-Output 'PASS archived verifier, exact builder pathspec, reviewed commit and explicit Git repository; verified synthetic fixture removed.'
} catch { Write-Error "Archive closure failed; synthetic root retained: $root"; throw }
