param([Parameter(Mandatory)][string]$ManifestPath,[Parameter(Mandatory)][string]$ReviewManifestPath,
 [Parameter(Mandatory)][string]$ReviewDirectory,[Parameter(Mandatory)][string]$BuildRoot,[Parameter(Mandatory)][string]$SourceRepository)
# Read-only consistency check; no promotion, trust, authentication or release authorization.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
function SafeDir([string]$p){
 if(-not [IO.Path]::IsPathFullyQualified($p) -or $p.StartsWith('\\')){throw 'Absolute local directory required.'}
 $p=[IO.Path]::GetFullPath($p).TrimEnd('\');if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($p)).DriveType -ne [IO.DriveType]::Fixed){throw 'Fixed drive required.'}
 for($x=$p;$x;$x=[IO.Path]::GetDirectoryName($x)){$f=Get-Item -LiteralPath $x -Force;if(-not $f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Directory alias refused.'}};return $p
}
function ReadSafe([string]$p){
 if(-not [IO.Path]::IsPathFullyQualified($p) -or $p.StartsWith('\\')){throw 'Absolute local input required.'}
 $p=[IO.Path]::GetFullPath($p);$null=SafeDir ([IO.Path]::GetDirectoryName($p));$f=Get-Item -LiteralPath $p -Force
 if($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -lt 1 -or $f.Length -gt 1048576){throw 'Invalid record file.'}
 return [IO.File]::ReadAllBytes($p)
}
function Json([byte[]]$bytes){
 $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xFEFF);$doc=[Text.Json.JsonDocument]::Parse($text)
 function Unique($value){if($value.ValueKind -eq [Text.Json.JsonValueKind]::Object){$keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($p in $value.EnumerateObject()){if(-not $keys.Add($p.Name)){throw 'Duplicate JSON key.'};Unique $p.Value}}elseif($value.ValueKind -eq [Text.Json.JsonValueKind]::Array){foreach($e in $value.EnumerateArray()){Unique $e}}}
 try{Unique $doc.RootElement}finally{$doc.Dispose()};return ConvertFrom-Json -InputObject $text -AsHashtable
}
function Sha([byte[]]$bytes){[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes))}
function Keys($obj,[string[]]$keys){if($obj -isnot [Collections.IDictionary] -or [string]::Join(',',@($obj.Keys|Sort-Object)) -cne [string]::Join(',',@($keys|Sort-Object))){throw 'Unexpected record fields.'}}
function HashPin($value,[int]$length){if($value -isnot [string] -or $value -cnotmatch ('\A[0-9a-f]{'+$length+'}\z')){throw 'Invalid pin.'}}
function StopTimedOutGit($process){
 try{$process.Kill($true)}catch{[Console]::Error.WriteLine("Owned git process $($process.Id) could not be stopped; waiting for its exit.")}
 if(-not $process.WaitForExit(5000)){[Console]::Error.WriteLine("Owned git process $($process.Id) remains active; waiting for its exit.");$process.WaitForExit()}
}
$reviewRoot=SafeDir $ReviewDirectory;$null=SafeDir $BuildRoot;$repo=SafeDir $SourceRepository
$baseBytes=ReadSafe $ManifestPath;$base=Json $baseBytes;$review=Json (ReadSafe $ReviewManifestPath)
Keys $review @('schemaVersion','baseManifestSha256','sourceTree','builderIdentity','reviews')
if(($review.schemaVersion -isnot [int] -and $review.schemaVersion -isnot [long]) -or $review.schemaVersion -ne 1){throw 'Unsupported schema.'}
HashPin $review.baseManifestSha256 64;HashPin $review.sourceTree 40
if((Sha $baseBytes) -cne $review.baseManifestSha256 -or $review.builderIdentity -isnot [string] -or $review.builderIdentity -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9 ._@-]{1,79}\z'){throw 'Manifest or builder identity invalid.'}
# Reuse the existing verifier unchanged. It validates exact commit/archive/inventory/receipt/application pins.
$baseResult=& (Join-Path $PSScriptRoot 'windows-pilot-evidence-verify.ps1') -ManifestPath $ManifestPath -BuildRoot $BuildRoot -SourceRepository $SourceRepository | ConvertFrom-Json -AsHashtable
if($baseResult.status -cne 'byte_consistency_verified_only'){throw 'Base byte check failed.'}
$receipt=Json (ReadSafe (Join-Path $BuildRoot 'build-receipt.json'))
foreach($k in @('sourceTree','builderSha256','dotnetSha256','helperSha256','sdk','restoreSource')){if($receipt[$k] -isnot [string] -or -not $receipt[$k]){throw 'Build input evidence absent.'}}
foreach($k in @('builderSha256','dotnetSha256','helperSha256')){HashPin $receipt[$k] 64}
if($receipt.sourceTree -cne $review.sourceTree -or $receipt.sdk -cne '10.0.402'){throw 'Tree or SDK does not match.'}
$start=[Diagnostics.ProcessStartInfo]::new('git');$start.WorkingDirectory=$repo;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
foreach($a in @('rev-parse',($base.sourceCommit+':apps/windows-download'))){$start.ArgumentList.Add($a)}
$p=[Diagnostics.Process]::Start($start)
try{
 $out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
 if(-not $p.WaitForExit(10000)){
  StopTimedOutGit $p
  throw 'Tree check timed out.'
 }
 $tree=$out.GetAwaiter().GetResult().Trim();$null=$err.GetAwaiter().GetResult();if($p.ExitCode -ne 0 -or $tree -cne $review.sourceTree){throw 'Git source tree differs.'}
}finally{if(-not $p.HasExited){[Console]::Error.WriteLine("Waiting for owned git process $($p.Id) before releasing it.");$p.WaitForExit()};$p.Dispose()}
if($review.reviews -isnot [array] -or $review.reviews.Count -ne 2){throw 'Two independent review records required.'}
$kinds=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);$people=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($entry in $review.reviews){
 Keys $entry @('kind','reviewer','file','sha256');HashPin $entry.sha256 64
 if($entry.kind -isnot [string] -or $entry.kind -cnotin @('source-scope','safety-and-tests') -or -not $kinds.Add($entry.kind) -or
    $entry.reviewer -isnot [string] -or $entry.reviewer -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9 ._@-]{1,79}\z' -or $entry.reviewer -ieq $review.builderIdentity -or -not $people.Add($entry.reviewer) -or
    $entry.file -isnot [string] -or $entry.file -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json\z'){throw 'Review identity, kind or path invalid.'}
 $bytes=ReadSafe (Join-Path $reviewRoot $entry.file);if((Sha $bytes) -cne $entry.sha256){throw 'Review record bytes differ.'};$record=Json $bytes
 Keys $record @('kind','reviewer','result','findings','sourceCommit','sourceTree','sourceArchiveSha256','version','receiptSha256','inventorySha256','applicationSha256','builderSha256','dotnetSha256','helperSha256','sdk','restoreSource','syntheticTestEvidenceSha256')
 foreach($key in $record.Keys){if($record[$key] -isnot [string]){throw 'Review record fields must be strings.'}}
 if([string]::IsNullOrWhiteSpace($record.findings) -or $record.findings.Length -gt 4000){throw 'Review findings must be bounded and nonempty.'}
 if($record.kind -cne $entry.kind -or $record.reviewer -cne $entry.reviewer -or $record.result -cne 'pass' -or $record.sourceCommit -cne $base.sourceCommit -or $record.sourceTree -cne $review.sourceTree -or $record.sourceArchiveSha256 -cne $base.sourceArchiveSha256 -or $record.version -cne $base.version -or $record.receiptSha256 -cne $base.receiptSha256 -or $record.inventorySha256 -cne $base.inventorySha256 -or $record.applicationSha256 -cne $base.applicationSha256){throw 'Review binding differs.'}
 foreach($key in @('builderSha256','dotnetSha256','helperSha256','sdk','restoreSource')){if($record[$key] -isnot [string] -or $record[$key] -cne $receipt[$key]){throw 'Review build inputs differ.'}}
 HashPin $record.syntheticTestEvidenceSha256 64
 if(@($base.evidence | Where-Object { $_.classification -ceq 'synthetic' -and $_.sha256 -ceq $record.syntheticTestEvidenceSha256 }).Count -ne 1){throw 'Reviewed synthetic test evidence is absent.'}
}
[ordered]@{status='preinstall_evidence_structure_checked';sourceCommit=$base.sourceCommit;version=$base.version;reviewRecords=2;reviewIdentityAuthenticated=$false;reviewClaimsVerified=$false;buildProvenanceVerified=$false;qualificationVerified=$false;installerEligibilityChanged=$false;installed=$false;liveTransferTested=$false} | ConvertTo-Json
