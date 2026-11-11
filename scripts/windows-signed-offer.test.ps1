param([Parameter(Mandatory)][string]$FixtureDirectory)
$ErrorActionPreference='Stop'
$installer=Join-Path $FixtureDirectory 'installer/LedgeTop-Files-Pilot-0.5.1.0-unsigned-setup.exe'
$payload=Join-Path $FixtureDirectory 'payload'
$test=Join-Path $FixtureDirectory ('signed-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($test)|Out-Null
try {
  # Synthetic certificate table only: this is not a valid signature.
  $u=[IO.File]::ReadAllBytes($installer); $pe=[BitConverter]::ToInt32($u,60); $opt=$pe+24
  $magic=[BitConverter]::ToUInt16($u,$opt); $dir=if($magic -eq 0x10b){$opt+96}else{if($magic -eq 0x20b){$opt+112}else{throw 'Unsupported fixture PE'}}
  $offset=($u.Length+7)-band (-bnot 7); $s=[byte[]]::new($offset+16); [Array]::Copy($u,$s,$u.Length)
  [BitConverter]::GetBytes([uint32]$offset).CopyTo($s,$dir+32); [BitConverter]::GetBytes([uint32]16).CopyTo($s,$dir+36)
  [BitConverter]::GetBytes([uint32]16).CopyTo($s,$offset); [BitConverter]::GetBytes([uint16]0x200).CopyTo($s,$offset+4); [BitConverter]::GetBytes([uint16]2).CopyTo($s,$offset+6)
  $fake=Join-Path $test 'synthetic-table.exe'; [IO.File]::WriteAllBytes($fake,$s)
  $offer=Join-Path $test 'offer.json'
  $args=@{InstallerReceiptPath=(Join-Path $FixtureDirectory 'installer/installer-build-receipt.json');InstallerPath=$installer;SignedInstallerPath=$fake;PayloadAssemblyPath=(Join-Path $payload 'app/LedgeTop.Files.dll');PayloadBuildReceiptPath=(Join-Path $payload 'build-receipt.json');PayloadInventoryPath=(Join-Path $payload 'payload-inventory.json');ApprovedChannel='pilot';SiteKind='operations';SourceRepository=([IO.Path]::GetDirectoryName($PSScriptRoot));OutputPath=$offer}
  $null=& (Join-Path $PSScriptRoot 'windows-app-release-offer.ps1') @args
  $o=Get-Content -Raw $offer|ConvertFrom-Json; $r=Get-Content -Raw ($offer+'.construction-receipt.json')|ConvertFrom-Json
  $hash=(Get-FileHash $fake -Algorithm SHA256).Hash.ToLowerInvariant()
  if($o.sizeBytes -ne $s.Length -or $o.strongETag -cne ('"sha256-'+$hash+'"') -or $r.signatureTrustVerified -or $r.publisherApprovalProven -or $r.published -or $r.endpointImplemented){throw 'Synthetic offer metadata or trust flags differ.'}
  # Changing a byte in the original NSIS payload must prevent offer creation.
  $s[$u.Length-1]=$s[$u.Length-1] -bxor 1; [IO.File]::WriteAllBytes($fake,$s)
  $args.OutputPath=Join-Path $test 'invalid.json'; $rejected=$false
  try {$null=& (Join-Path $PSScriptRoot 'windows-app-release-offer.ps1') @args} catch {$rejected=$true}
  if(-not $rejected -or (Test-Path -LiteralPath $args.OutputPath)){throw 'Mutated NSIS payload was accepted.'}
  Write-Output 'PASS synthetic NSIS certificate-table offer and mutated overlay refusal; signature trust not tested.'
} finally { Remove-Item -LiteralPath $test -Recurse -Force }
