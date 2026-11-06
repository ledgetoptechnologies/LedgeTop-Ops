param([Parameter(Mandatory)][string]$ManifestPath,[Parameter(Mandatory)][string]$BuildRoot,[Parameter(Mandatory)][string]$SourceRepository)
# Local read-only consistency check. It never changes a receipt or approves a release.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
function ReadJson([string]$Path,[int]$Limit) {
  $file=Get-Item -LiteralPath $Path -Force
  if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -lt 1 -or $file.Length -gt $Limit){throw 'Invalid JSON input.'}
  $bytes=[IO.File]::ReadAllBytes($Path); $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xFEFF)
  $doc=[Text.Json.JsonDocument]::Parse($text)
  function CheckUnique($element) {
    if($element.ValueKind -eq [Text.Json.JsonValueKind]::Object){$keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($prop in $element.EnumerateObject()){if(-not $keys.Add($prop.Name)){throw 'Duplicate JSON key.'};CheckUnique $prop.Value}}
    elseif($element.ValueKind -eq [Text.Json.JsonValueKind]::Array){foreach($item in $element.EnumerateArray()){CheckUnique $item}}
  }
  try { CheckUnique $doc.RootElement } finally {$doc.Dispose()}
  return ConvertFrom-Json -InputObject $text -AsHashtable
}
function SafeDir([string]$Path) {
  if(-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')){throw 'Use absolute local paths.'}
  $full=[IO.Path]::GetFullPath($Path).TrimEnd('\'); if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed){throw 'Use a fixed drive.'}
  for($p=$full;$p;$p=[IO.Path]::GetDirectoryName($p)){ $item=Get-Item -LiteralPath $p -Force; if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Directory alias refused.'} }; return $full
}
function Digest([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Pin($Value,[int]$Length) { if($Value -isnot [string] -or $Value -cnotmatch ('\A[0-9a-f]{'+$Length+'}\z')){throw 'Invalid hash pin.'} }
function StopOwnedArchive($process) {
 try{$process.Kill($true)}catch{[Console]::Error.WriteLine("Owned git archive process $($process.Id) could not be stopped; waiting for exit.")}
 if(-not $process.WaitForExit(5000)){[Console]::Error.WriteLine("Owned git archive process $($process.Id) remains active; waiting for exit.");$process.WaitForExit()}
}
function Rel($Value) {
 if($Value -isnot [string] -or $Value.Length -eq 0 -or $Value.Length -gt 240 -or $Value.Contains('\') -or [IO.Path]::IsPathRooted($Value)){throw 'Invalid relative path.'}
 foreach($part in $Value.Split('/')){if($part.Length -eq 0 -or $part -in @('.','..') -or $part -match '[<>:"\\|?*\x00-\x1f]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '\A(?i:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)'){throw 'Unsafe path component.'}}
 return $Value
}
$root=SafeDir $BuildRoot; $repo=SafeDir $SourceRepository
if(-not [IO.Path]::IsPathFullyQualified($ManifestPath) -or $ManifestPath.StartsWith('\\')){throw 'Manifest must be an absolute local file.'}
$ManifestPath=[IO.Path]::GetFullPath($ManifestPath)
$null=SafeDir ([IO.Path]::GetDirectoryName($ManifestPath))
$manifest=ReadJson $ManifestPath 1048576
$keys=@('schemaVersion','sourceCommit','version','sourceArchiveSha256','inventorySha256','applicationSha256','receiptSha256','evidence')
if($manifest -isnot [Collections.IDictionary] -or [string]::Join(',',@($manifest.Keys|Sort-Object)) -cne [string]::Join(',',@($keys|Sort-Object)) -or ($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or $manifest.schemaVersion -ne 1){throw 'Unknown evidence manifest shape.'}
Pin $manifest.sourceCommit 40; foreach($key in @('sourceArchiveSha256','inventorySha256','applicationSha256','receiptSha256')){Pin $manifest[$key] 64}
if($manifest.version -isnot [string] -or $manifest.version -cnotmatch '\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}\z' -or @($manifest.version.Split('.')|Where-Object{[int]$_ -gt 65535}).Count){throw 'Invalid version.'}
$receiptPath=Join-Path $root 'build-receipt.json';$invPath=Join-Path $root 'payload-inventory.json';$archive=Join-Path $root 'source.zip';$payload=SafeDir (Join-Path $root 'payload')
foreach($path in @($receiptPath,$invPath,$archive)){ $entry=Get-Item -LiteralPath $path -Force; if($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid build file.'} }
if((Digest $receiptPath) -cne $manifest.receiptSha256 -or (Digest $invPath) -cne $manifest.inventorySha256 -or (Digest $archive) -cne $manifest.sourceArchiveSha256){throw 'Pinned build bytes differ.'}
$receipt=ReadJson $receiptPath 4194304
foreach($key in @('status','sourceCommit','applicationVersion','sourceArchiveSha256','inventorySha256','applicationSha256')){if($receipt[$key] -isnot [string]){throw 'Receipt text has an invalid JSON type.'}}
foreach($key in @('freshGenerationStagingQualified','sourceAcceptanceVerified','installed','published','liveTransferTested')){if($receipt[$key] -isnot [bool]){throw 'Receipt boolean has an invalid JSON type.'}}
foreach($key in @('payloadFiles','payloadBytes')){if($receipt[$key] -isnot [int] -and $receipt[$key] -isnot [long]){throw 'Receipt count has an invalid JSON type.'}}
if($receipt.status -cne 'connected_payload_unqualified' -or $receipt.freshGenerationStagingQualified -ne $false -or $receipt.sourceAcceptanceVerified -ne $false -or $receipt.installed -ne $false -or $receipt.published -ne $false -or $receipt.liveTransferTested -ne $false -or $receipt.sourceCommit -cne $manifest.sourceCommit -or $receipt.applicationVersion -cne $manifest.version -or $receipt.sourceArchiveSha256 -cne $manifest.sourceArchiveSha256 -or $receipt.inventorySha256 -cne $manifest.inventorySha256 -or $receipt.applicationSha256 -cne $manifest.applicationSha256){throw 'Receipt and expected evidence do not match.'}
# Verify the source archive against git's deterministic archive stream for the exact commit.
$start=[Diagnostics.ProcessStartInfo]::new('git');$start.WorkingDirectory=$repo;$start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
foreach($a in @('archive','--format=zip',$manifest.sourceCommit,'--','apps/windows-download','apps/operations/public/favicon.ico','scripts/windows-package-channel-check.ps1','scripts/windows-unsigned-installer.ps1','scripts/windows-package-runtime-notices.ps1','scripts/windows-explorer-preview-notices.ps1','scripts/windows-package-go-notices.ps1','docs/staging/windows-helper-module-notices-2026-10-22','docs/staging/windows-helper-build-provenance-2026-10-22/go-runtime-notices','docs/staging/windows-helper-build-provenance-2026-10-22/go-runtime-notices.json')){$start.ArgumentList.Add($a)}
$p=[Diagnostics.Process]::Start($start);$er=$p.StandardError.ReadToEndAsync();$sha=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256);$deadline=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
try {
  $buffer=[byte[]]::new(65536);$total=0L
  while($true){$n=$p.StandardOutput.BaseStream.ReadAsync($buffer,0,$buffer.Length,$deadline.Token).GetAwaiter().GetResult();if($n -eq 0){break};$total+=$n;if($total -gt 134217728){throw 'Source archive exceeds verification limit.'};$sha.AppendData($buffer,0,$n)}
  $null=$p.WaitForExitAsync($deadline.Token).GetAwaiter().GetResult();$null=$er.WaitAsync($deadline.Token).GetAwaiter().GetResult();$archiveHash=[Convert]::ToHexStringLower($sha.GetHashAndReset())
  if($p.ExitCode -ne 0 -or $archiveHash -cne $manifest.sourceArchiveSha256){throw 'Archive does not match the specified source commit.'}
} finally {
  if(-not $p.HasExited){StopOwnedArchive $p}
  $deadline.Dispose();$sha.Dispose();$p.Dispose()
}
$inventory=@(ReadJson $invPath 8388608); if($inventory.Count -eq 0 -or $inventory.Count -gt 4096){throw 'Invalid inventory count.'}; $expected=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase);$bytes=0L
foreach($item in $inventory){if($item -isnot [Collections.IDictionary] -or [string]::Join(',',@($item.Keys|Sort-Object)) -cne 'bytes,path,sha256' -or $item.bytes -isnot [int] -and $item.bytes -isnot [long] -or $item.bytes -lt 0 -or $item.bytes -gt 2147483648){throw 'Invalid inventory record.'};$relative=Rel $item.path;Pin $item.sha256 64;if(-not $expected.TryAdd($relative,$item)){throw 'Duplicate inventory path.'};$bytes += [long]$item.bytes}
$actual=@(Get-ChildItem -LiteralPath $payload -Force -Recurse);$observed=0
foreach($f in $actual){if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Payload alias refused.'};if($f.PSIsContainer){continue};$rel=[IO.Path]::GetRelativePath($payload,$f.FullName).Replace('\','/');$entry=$null;if(-not $expected.TryGetValue($rel,[ref]$entry) -or $entry.path -cne $rel -or $entry.bytes -ne $f.Length -or (Digest $f.FullName) -cne $entry.sha256){throw 'Payload differs from inventory.'};$observed++}
if($observed -ne $inventory.Count -or $receipt.payloadFiles -ne $observed -or $receipt.payloadBytes -ne $bytes -or $expected['LedgeTop.Files.dll'].sha256 -cne $manifest.applicationSha256){throw 'Payload counts or app hash differ.'}
if($manifest.evidence -isnot [array] -or $manifest.evidence.Count -gt 100){throw 'Invalid evidence list.'};$evidence=@();$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($item in $manifest.evidence){if($item -isnot [Collections.IDictionary] -or [string]::Join(',',@($item.Keys|Sort-Object)) -cne 'classification,path,sha256' -or $item.classification -isnot [string] -or $item.classification -cnotin @('synthetic','installed','connected-live')){throw 'Invalid evidence classification.'};$rel=Rel $item.path;Pin $item.sha256 64;if(-not $seen.Add($rel)){throw 'Duplicate evidence path.'};$file=Join-Path $root $rel; $parent=SafeDir ([IO.Path]::GetDirectoryName($file));if(-not $parent.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -and $parent -cne $root){throw 'Evidence outside build root.'};$fi=Get-Item -LiteralPath $file -Force;if($fi.PSIsContainer -or ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Digest $file) -cne $item.sha256){throw 'Evidence bytes differ.'};$evidence+=@{classification=$item.classification;sha256=$item.sha256;interpretation='unverified supplied evidence; no outcome inferred'}}
[ordered]@{status='byte_consistency_verified_only';sourceCommit=$manifest.sourceCommit;version=$manifest.version;payloadFiles=$observed;evidence=$evidence;qualificationVerified=$false;buildProvenanceVerified=$false;installationVerified=$false;liveTransferVerified=$false;installerEligibilityChanged=$false} | ConvertTo-Json -Depth 5
