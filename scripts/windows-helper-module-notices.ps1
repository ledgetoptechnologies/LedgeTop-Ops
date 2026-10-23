param(
  [Parameter(Mandatory)][string]$InventoryPath,
  [Parameter(Mandatory)][string]$CacheDirectory,
  [Parameter(Mandatory)][string]$OutputDirectory
)

# Read-only network collection from Google's official public Go module proxy.
# Never execute downloaded content. No module install, authentication or fallback
# to a branch/repository HEAD. h1 content hashes must match the qualified binary.
$ErrorActionPreference = 'Stop'
function Hash([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function Directory([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'Use an absolute local fixed-drive directory.' }
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use a local fixed drive.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if ((Test-Path -LiteralPath $part) -and ([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are not collection inputs.' }
  }
  $null = [IO.Directory]::CreateDirectory($full)
  $full
}
function EscapeModule([string]$Value) { [regex]::Replace($Value, '[A-Z]', { param($match) '!' + $match.Value.ToLowerInvariant() }) }
$inventoryBytes = [IO.File]::ReadAllBytes($InventoryPath)
$inventoryText = [Text.Encoding]::UTF8.GetString($inventoryBytes).Replace("`r`n", "`n")
if ((Hash ([Text.Encoding]::UTF8.GetBytes($inventoryText))) -cne '64bd4d31b74dcd7bd2065fa61a839728e45dbb9383420b7633a5a86257faa4f7') { throw 'Linked-module inventory differs from the qualified binary observation.' }
$inventory = $inventoryText | ConvertFrom-Json
if ($inventory.helperSha256 -cne '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2' -or $inventory.modules.Count -ne 66) { throw 'Expected the qualified helper linked-module inventory.' }
$cache = Directory $CacheDirectory
$output = Directory $OutputDirectory
if (@(Get-ChildItem -LiteralPath $output -Force).Count -ne 0) { throw 'Use a new empty output directory; existing vendor material is never replaced.' }
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromMinutes(2)
$client.MaxResponseContentBufferSize = 100MB
$result = @()
try {
  $ordinal = 0
  foreach ($reference in $inventory.modules) {
    $ordinal++
    $resolved = if ($reference.replacement) { $reference.replacement } else { $reference }
    if ($resolved.path -cnotmatch '^[A-Za-z0-9._/-]+$' -or $resolved.version -cnotmatch '^v[0-9A-Za-z.+-]+$' -or $resolved.sum -cnotmatch '^h1:[A-Za-z0-9+/]{43}=$') { throw 'Invalid pinned module identity.' }
    $identity = "$($resolved.path)@$($resolved.version)"
    $key = Hash ([Text.Encoding]::UTF8.GetBytes($identity))
    $zipPath = Join-Path $cache "$key.zip"
    $url = "https://proxy.golang.org/$(EscapeModule $resolved.path)/@v/$(EscapeModule $resolved.version).zip"
    if (-not (Test-Path -LiteralPath $zipPath)) {
      $response = $client.GetAsync($url).GetAwaiter().GetResult()
      try {
        $null = $response.EnsureSuccessStatusCode()
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ($bytes.Length -gt 100MB) { throw 'Oversized module ZIP.' }
        $file = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($bytes) } finally { $file.Dispose() }
      } finally { $response.Dispose() }
    }
    if (([IO.File]::GetAttributes($zipPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse archive input.' }
    $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
    $notices = @(); $summary = [Text.StringBuilder]::new()
    try {
      # Go sumdb/dirhash.HashZip: UTF-8 filename order and sha256(file) + two
      # spaces + complete ZIP entry name + LF. Module ZIP paths are ASCII here.
      $names = [string[]]@($zip.Entries.FullName)
      [Array]::Sort($names, [StringComparer]::Ordinal)
      $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
      $totalBytes = 0L
      foreach ($name in $names) {
        if (-not $seen.Add($name) -or -not $name.StartsWith("$identity/", [StringComparison]::Ordinal) -or $name -match '[\r\n\x00-\x1f\x7f-\xff]' -or $name.Contains('/../') -or $name.Contains('\')) { throw 'Unexpected module ZIP path.' }
        $entry = $zip.GetEntry($name)
        $totalBytes += $entry.Length
        if ($entry.Length -gt 50MB -or $totalBytes -gt 500MB) { throw 'Oversized module content.' }
        $stream = $entry.Open()
        try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() } finally { $stream.Dispose() }
        $null = $summary.Append("$hash  $name`n")
        $relative = $name.Substring($identity.Length + 1)
        $leaf = $relative.Split('/')[-1]
        if ($leaf -match '^(?i:licen[cs]e|copying|notice|copyright|authors)([._ -].*)?$' -or $relative -match '(?i)(^|/)(licenses|licences)/') {
          if ($entry.Length -gt 2MB) { throw 'Oversized vendor notice.' }
          $stream = $entry.Open(); $memory = [IO.MemoryStream]::new()
          try { $stream.CopyTo($memory); $noticeBytes = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
          $notices += @{entry=$relative;bytes=$noticeBytes;sha256=$hash}
        }
      }
      $contentHash = 'h1:' + [Convert]::ToBase64String([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($summary.ToString())))
      if ($contentHash -cne $resolved.sum) { throw "Module content hash differs: $identity" }
      $moduleDirectory = '{0:D2}-{1}' -f $ordinal,$key.Substring(0,16)
      $noticeRecords = @()
      foreach ($notice in $notices) {
        # Retain nested provenance in the manifest; output uses numbered opaque
        # files, never untrusted archive paths or executable source extraction.
        $relativeOutput = "$moduleDirectory/$('{0:D3}' -f $noticeRecords.Count)-$([IO.Path]::GetFileName($notice.entry)).txt"
        $destination = Join-Path $output $relativeOutput
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        $file = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($notice.bytes) } finally { $file.Dispose() }
        $noticeRecords += [pscustomobject]@{moduleEntry=$notice.entry;outputPath=$relativeOutput;bytes=$notice.bytes.Length;sha256=$notice.sha256}
      }
      $result += [pscustomobject]@{linkedPath=$reference.path;linkedVersion=$reference.version;resolvedPath=$resolved.path;resolvedVersion=$resolved.version;replacement=($null -ne $reference.replacement);sourceUrl=$url;zipSha256=(Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant();goContentHash=$contentHash;contentHashMatchesQualifiedBinary=$true;noticeCount=$noticeRecords.Count;notices=$noticeRecords}
      Write-Host "[$ordinal/66] verified $identity; retained $($noticeRecords.Count) notice files"
    } finally { $zip.Dispose() }
  }
} finally { $client.Dispose() }
$receipt = [pscustomobject]@{schemaVersion=1;inventorySha256=(Hash $inventoryBytes);helperSha256=$inventory.helperSha256;moduleInfoSha256=$inventory.moduleInfoSha256;moduleCount=$result.Count;modulesWithoutNotice=@($result | Where-Object noticeCount -eq 0 | ForEach-Object resolvedPath);completeThirdPartyAttribution=$false;limitations=@('Filename-based collection includes unused subpackage/test notices conservatively; embedded source-only notices require review.','Go runtime/toolchain and linked native CGO libraries are outside this module-only bundle.','The upstream helper reports vcs.modified=true; linked module hashes do not establish complete main-module/native source provenance.');modules=$result}
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'manifest.json') -Encoding utf8
$receipt | Select-Object moduleCount,modulesWithoutNotice,completeThirdPartyAttribution | ConvertTo-Json -Depth 3
