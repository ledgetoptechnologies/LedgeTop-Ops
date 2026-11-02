param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$SourceArchivePath,
  [string]$HelperPath,
  [string]$HelperLicensePath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Public build tools only. Never executes cloudflared, an app, or a generated PE.
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function SafePath([string]$path){
  if(-not[IO.Path]::IsPathFullyQualified($path)-or$path.StartsWith('\\')-or($path.Length-gt2-and$path.Substring(2).Contains(':'))){throw 'Use an absolute local ordinary path.'}
  $full=[IO.Path]::GetFullPath($path)
  if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType-ne[IO.DriveType]::Fixed){throw 'Use a local fixed drive.'}
  for($part=$full;$null-ne$part;$part=[IO.Path]::GetDirectoryName($part)){
    if(Test-Path -LiteralPath $part){if(([IO.File]::GetAttributes($part)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Build tool paths cannot be aliases.'}}
  }
  $full
}
function VerifiedInput([string]$path,[long]$length,[string]$sha){
  $full=SafePath $path
  if(-not[IO.File]::Exists($full)-or(Get-Item -LiteralPath $full).Length-ne$length-or(Hash $full)-cne$sha){throw 'Pinned public tool input differs.'}
  $full
}
function Download([string]$url,[long]$length,[string]$sha,[string]$target,[string]$kind){
  $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.UseCookies=$false;$handler.UseDefaultCredentials=$false
  $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(90);$client.MaxResponseContentBufferSize=$length+1
  try{
    $uri=[Uri]$url
    for($hop=0;$hop-le5;$hop++){
      $response=$client.GetAsync($uri).GetAwaiter().GetResult()
      try{
        if([int]$response.StatusCode-in@(301,302,303,307,308)){
          if($hop-eq5-or$null-eq$response.Headers.Location){throw 'Public tool redirect refused.'}
          $next=[Uri]::new($uri,$response.Headers.Location)
          $hostAllowed=switch($kind){
            'nsis' {$next.Host-eq'downloads.sourceforge.net'-or$next.Host.EndsWith('.dl.sourceforge.net',[StringComparison]::Ordinal)}
            'helper' {$next.Host-eq'release-assets.githubusercontent.com'}
            default {$false}
          }
          if(-not$hostAllowed-or$next.Scheme-cne'https'-or-not$next.IsDefaultPort-or$next.UserInfo-or$next.Fragment){throw 'Public tool redirect target refused.'}
          if($kind-eq'nsis'-and-not$next.AbsolutePath.EndsWith('/nsis-3.13.zip',[StringComparison]::Ordinal)){throw 'NSIS redirect path refused.'}
          $uri=$next;continue
        }
        if([int]$response.StatusCode-ne200){throw 'Fixed public tool download refused.'}
        $bytes=$response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if($bytes.Length-ne$length-or[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()-cne$sha){throw 'Public tool bytes differ.'}
        [IO.File]::WriteAllBytes($target,$bytes);return
      }finally{$response.Dispose()}
    }
    throw 'Public tool redirect limit exceeded.'
  }finally{$client.Dispose();$handler.Dispose()}
}
$archiveSha='ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
$helperSha='76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
$licenseSha='58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd'
$output=SafePath $OutputDirectory
if(Test-Path -LiteralPath $output){throw 'Build tool output must be new.'}
$offlineCount=@($SourceArchivePath,$HelperPath,$HelperLicensePath|Where-Object{$_}).Count
if($offlineCount-ne0-and$offlineCount-ne3){throw 'Offline reuse requires all three pinned public inputs.'}
if($offlineCount-eq3){
  $SourceArchivePath=VerifiedInput $SourceArchivePath 2363925 $archiveSha
  $HelperPath=VerifiedInput $HelperPath 55329336 $helperSha
  $HelperLicensePath=VerifiedInput $HelperLicensePath 11357 $licenseSha
}
[IO.Directory]::CreateDirectory($output)|Out-Null
$archive=Join-Path $output 'nsis-3.13.zip';$helper=Join-Path $output 'cloudflared.exe';$license=Join-Path $output 'LICENSE.cloudflared.txt'
if($offlineCount-eq3){Copy-Item -LiteralPath $SourceArchivePath -Destination $archive;Copy-Item -LiteralPath $HelperPath -Destination $helper;Copy-Item -LiteralPath $HelperLicensePath -Destination $license}
else{
  Download 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip' 2363925 $archiveSha $archive 'nsis'
  Download 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-windows-amd64.exe' 55329336 $helperSha $helper 'helper'
  Download 'https://raw.githubusercontent.com/cloudflare/cloudflared/de6376c5af4a67cbc65258682e5a01781827643d/LICENSE' 11357 $licenseSha $license 'license'
}
# Verify downloaded/copied files again before any compiler can be used.
$null=VerifiedInput $archive 2363925 $archiveSha;$null=VerifiedInput $helper 55329336 $helperSha;$null=VerifiedInput $license 11357 $licenseSha
$signature=Get-AuthenticodeSignature -LiteralPath $helper
if($signature.Status-ne'Valid'-or$null-eq$signature.SignerCertificate-or$signature.SignerCertificate.Thumbprint-cne'0B6C68C4BAD79F9AC39E07FE84223FB796D4D0BC'){throw 'Exact qualified Cloudflare helper signature refused.'}
$toolchain=Join-Path $output 'toolchain';[IO.Directory]::CreateDirectory($toolchain)|Out-Null
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
$paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$manifest=[Collections.Generic.List[object]]::new();$expanded=0L
try{
  if($zip.Entries.Count-ne441){throw 'Pinned NSIS entry count differs.'}
  # Validate all entry paths and types before creating an extracted file.
  foreach($entry in $zip.Entries){
    $name=$entry.FullName;$directory=$name.EndsWith('/');$trimmed=$name.TrimEnd('/')
    if(-not$trimmed.StartsWith('nsis-3.13/',[StringComparison]::Ordinal)-and$trimmed-cne'nsis-3.13'){throw 'NSIS entry root differs.'}
    if($name.Contains('\')-or$name.Contains(':')-or$name.StartsWith('/')-or@($trimmed.Split('/')|Where-Object{$_-in@('.','..','')}).Count-gt0-or-not$paths.Add($trimmed)){throw 'Unsafe or duplicate NSIS archive entry.'}
    if(($entry.ExternalAttributes-band0x400)-ne0-or(($entry.ExternalAttributes-shr16)-band0xF000)-eq0xA000){throw 'NSIS archive aliases refused.'}
    $expanded+=$entry.Length;if($expanded-gt7141489-or$entry.Length-gt16MB){throw 'NSIS expanded bytes differ.'}
    $target=[IO.Path]::GetFullPath((Join-Path $toolchain $trimmed))
    if(-not$target.StartsWith($toolchain+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'NSIS extraction escaped its owned root.'}
    $manifest.Add([pscustomobject]@{entry=$entry;target=$target;directory=$directory})
  }
  if($expanded-ne7141489){throw 'NSIS expanded bytes differ.'}
  foreach($item in $manifest){
    if($item.directory){[IO.Directory]::CreateDirectory($item.target)|Out-Null;continue}
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.target))|Out-Null
    $input=$item.entry.Open();$stream=[IO.File]::Open($item.target,[IO.FileMode]::CreateNew)
    try{$input.CopyTo($stream);$stream.Flush($true)}finally{$stream.Dispose();$input.Dispose()}
  }
  foreach($item in $manifest){if(-not$item.directory){
    $input=$item.entry.Open();try{$expected=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($input)).ToLowerInvariant()}finally{$input.Dispose()}
    if((Get-Item -LiteralPath $item.target).Length-ne$item.entry.Length-or(Hash $item.target)-cne$expected){throw 'Extracted NSIS file differs from pinned ZIP.'}
  }}
}finally{$zip.Dispose()}
$compiler=Join-Path $toolchain 'nsis-3.13/Bin/makensis.exe';$copying=Join-Path $toolchain 'nsis-3.13/COPYING'
if((Hash $compiler)-cne'65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a'-or(Hash $copying)-cne'388357c1215ff403c5ebde3a5ecd273e68f8b79a579996775245d1ee65442aba'){throw 'Pinned NSIS compiler/license differs.'}
# No compiler, helper or generated executable is invoked here.
$receipt=[ordered]@{schemaVersion=1;status='public-packaging-test-tools-qualified';helperPath=$helper;compilerPath=$compiler;helperVersion='2026.10.3';helperSha256=$helperSha;nsisVersion='3.13';archiveSha256=$archiveSha;nsisEntries=441;nsisExpandedBytes=$expanded;helperSignatureValid=$true;downloaded=($offlineCount-eq0);compilerExecuted=$false;helperExecuted=$false;applicationExecuted=$false;installerExecuted=$false;globalSettingsChanged=$false}
$json=$receipt|ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $output 'receipt.json'),$json,[Text.UTF8Encoding]::new($false))
$json
