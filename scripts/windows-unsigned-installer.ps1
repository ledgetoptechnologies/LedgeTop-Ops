param(
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$PayloadInventoryPath,
  [Parameter(Mandatory)][string]$BuildReceiptPath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [Parameter(Mandatory)][string]$AppVersion,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$SourceRepository = ([IO.Path]::GetDirectoryName($PSScriptRoot)),
  [string]$CompilerRoot = 'C:/Users/fstor/.codex/cache/windows-download-nsis-3.13-20261025/toolchain/nsis-3.13',
  [switch]$ValidateOnly
)

# Unsigned manual per-user construction only. Never runs the app, installer,
# uninstaller, authentication helper or any deployment/signing command.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helperSha = '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
$compilerSha = '65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a'
$archiveSha = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
$copyingSha = '388357c1215ff403c5ebde3a5ecd273e68f8b79a579996775245d1ee65442aba'
$inventoryLeaf = 'installed-payload-inventory.json'
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Leaf([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 150 -or $Value -in @('.','..') -or
      $Value -match '[<>:"/\\|?*\x00-\x1f\p{Cf}\p{Cs}]' -or $Value.EndsWith('.') -or $Value.EndsWith(' ') -or
      $Value -match '\A(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') { throw 'Unsafe Windows filename.' }
}
function LocalPath([string]$Path, [bool]$AllowMissingLeaf = $false) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\') -or
      $Path -match '(^|[\\/])\.{1,2}([\\/]|$)' -or $Path.IndexOfAny([char[]]@('$','"','`',"`r","`n",[char]0)) -ge 0) {
    throw 'Use an absolute local canonical build path without NSIS metacharacters.'
  }
  # Windows GetFullPath silently strips trailing dots/spaces; reject those aliases BEFORE normalization.
  $raw = $Path.Replace('/','\'); $rawRoot = [IO.Path]::GetPathRoot($raw)
  foreach ($part in $raw.Substring($rawRoot.Length).Split('\')) { Leaf $part }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $root = [IO.Path]::GetPathRoot($full)
  if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed -or $full -eq $root.TrimEnd('\')) { throw 'Use a dedicated path on a fixed local drive.' }
  foreach ($part in $full.Substring($root.Length).Split('\')) { Leaf $part }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    try { $attributes = [IO.File]::GetAttributes($part) }
    catch [IO.FileNotFoundException] { if ($AllowMissingLeaf -and $part -eq $full) { continue }; throw }
    catch [IO.DirectoryNotFoundException] { if ($AllowMissingLeaf -and $part -eq $full) { continue }; throw }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Build inputs/outputs cannot be aliases.' }
    if ($part -ne $full -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'A build ancestor is not a directory.' }
  }
  $full
}
function RelativePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Unsafe payload relative path.' }
  if ($Path.Contains('\')) { throw 'Payload inventory paths must use canonical forward-slash spelling.' }
  if ($Path.Length -gt 240 -or
      [IO.Path]::IsPathRooted($Path) -or $Path.IndexOfAny([char[]]@('$','"','`','!',"`r","`n")) -ge 0) { throw 'Unsafe payload relative path.' }
  foreach ($part in $Path.Split('/')) { Leaf $part }
  if ($Path.Split('/')[0] -in @('installer-owned.ini','uninstall.exe',$inventoryLeaf)) { throw 'Payload collides with installer-owned files.' }
  $Path
}
function UniqueJson($Element) {
  if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) {
      if (-not $names.Add($property.Name)) { throw 'Duplicate JSON property.' }
      UniqueJson $property.Value
    }
  } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
    foreach ($item in $Element.EnumerateArray()) { UniqueJson $item }
  }
}
function JsonBytes([byte[]]$bytes) {
  $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { 3 } else { 0 }
  $text = [Text.UTF8Encoding]::new($false,$true).GetString($bytes,$offset,$bytes.Length-$offset)
  $options = [Text.Json.JsonDocumentOptions]::new(); $options.MaxDepth = 32
  $document = [Text.Json.JsonDocument]::Parse($text,$options)
  try { UniqueJson $document.RootElement } finally { $document.Dispose() }
  ConvertFrom-Json -InputObject $text -AsHashtable
}
function BoundedJsonBytes([string]$Path, [int]$MaximumBytes) {
  $info = Get-Item -LiteralPath $Path
  if ($info.PSIsContainer -or $info.Length -lt 1 -or $info.Length -gt $MaximumBytes) { throw 'JSON input size/type is invalid.' }
  $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes) { throw 'JSON input size/type is invalid.' }
    $bytes = [byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes)
    return ,$bytes
  } finally { $stream.Dispose() }
}
function Json([string]$Path, [int]$MaximumBytes) { JsonBytes (BoundedJsonBytes $Path $MaximumBytes) }
function AssertInventoryUnchanged {
  $null = LocalPath $PayloadInventoryPath
  if ((Get-Item -LiteralPath $PayloadInventoryPath).Length -ne $manifestBytes.Length -or (Hash $PayloadInventoryPath) -cne $manifestHash) { throw 'Payload inventory changed after verified snapshot.' }
}
function NsisLiteral([string]$Value) { $Value.Replace('$','$$').Replace('"','$\"') }
# The publish step must use the same four-part version for Version,
# AssemblyVersion and FileVersion as AppVersion; the installed app and updater
# read the assembly's version, not the installer's directory name.
function ApplicationMetadata([string]$AssemblyPath) {
  Add-Type -AssemblyName System.Reflection.Metadata
  $stream = [IO.File]::OpenRead($AssemblyPath)
  try {
    $pe = [Reflection.PortableExecutable.PEReader]::new($stream)
    try {
      if (-not $pe.HasMetadata) { throw 'Application must contain managed release metadata.' }
      $reader = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
      $channels = [Collections.Generic.List[string]]::new(); $protocols = [Collections.Generic.List[string]]::new(); $freshQualifications = [Collections.Generic.List[string]]::new(); $modes = 0
      foreach ($handle in $reader.GetAssemblyDefinition().GetCustomAttributes()) {
        $attribute = $reader.GetCustomAttribute($handle)
        if ($attribute.Constructor.Kind.ToString() -ne 'MemberReference') { continue }
        $member = $reader.GetMemberReference([Reflection.Metadata.MemberReferenceHandle]$attribute.Constructor)
        if ($member.Parent.Kind.ToString() -ne 'TypeReference') { continue }
        $type = $reader.GetTypeReference([Reflection.Metadata.TypeReferenceHandle]$member.Parent)
        if ($reader.GetString($type.Namespace) -cne 'System.Reflection' -or $reader.GetString($type.Name) -cne 'AssemblyMetadataAttribute') { continue }
        $blob = $reader.GetBlobReader($attribute.Value)
        if ($blob.ReadUInt16() -ne 1) { throw 'Malformed application metadata.' }
        $key = $blob.ReadSerializedString(); $value = $blob.ReadSerializedString()
        if ($key -ceq 'LedgeTop.ReleaseChannel') { $channels.Add($value) }
        if ($key -ceq 'LedgeTop.BuildMode') { $modes++ }
        if ($key -ceq 'LedgeTop.InstallerMaintenanceProtocol') { $protocols.Add($value) }
        if ($key -ceq 'LedgeTop.FreshGenerationStagingQualification') { $freshQualifications.Add($value) }
      }
      if ($channels.Count -ne 1 -or $channels[0] -cne 'pilot' -or $modes -ne 0 -or $protocols.Count -ne 1 -or $protocols[0] -cne '1' -or
          $freshQualifications.Count -ne 1 -or $freshQualifications[0] -cne 'true') {
        throw 'Payload must be a staging-qualified pilot, non-developer build with exactly one installer maintenance protocol1 marker.'
      }
      if ($reader.GetAssemblyDefinition().Version.ToString() -cne $AppVersion) {
        throw 'Application assembly version differs from installer version. Publish the app with the matching Version, AssemblyVersion and FileVersion.'
      }
    } finally { $pe.Dispose() }
  } finally { $stream.Dispose() }
}
function AssertCoreHasNoNativeDiagnostics([string]$AssemblyPath, [string]$ExpectedSha256) {
  # Inspect the exact sealed Core bytes, including prebuilt payloads. Never load
  # or execute the assembly. A receipt or current build flags cannot prove what
  # an older, already-published DLL actually contains.
  Add-Type -AssemblyName System.Reflection.Metadata
  $stream = [IO.File]::Open($AssemblyPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 1 -or $stream.Length -gt 67108864 -or $ExpectedSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Core assembly size or inventory hash is invalid.' }
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
    if ($actual -cne $ExpectedSha256) { throw 'Core assembly differs from the inventory.' }
    $stream.Position = 0
    $pe = [Reflection.PortableExecutable.PEReader]::new($stream)
    try {
      if (-not $pe.HasMetadata) { throw 'Core assembly is not a managed PE.' }
      $reader = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
      if (-not $reader.IsAssembly -or $reader.GetString($reader.GetAssemblyDefinition().Name) -cne 'LedgeTop.WindowsDownload') { throw 'Core assembly identity is invalid.' }
      foreach ($file in $reader.AssemblyFiles) {
        if ($reader.GetAssemblyFile($file).ContainsMetadata) { throw 'Multi-module Core assembly is unsupported.' }
      }
      $required = [Collections.Generic.Dictionary[string,int]]::new([StringComparer]::Ordinal)
      foreach ($name in @('CloudFilesConnectionOwner','CloudFilesNativeTransfer','PlaceholderHydrationCoordinator')) { $required.Add($name,0) }
      foreach ($handle in $reader.TypeDefinitions) {
        $type = $reader.GetTypeDefinition($handle); $name = $reader.GetString($type.Name); $ns = $reader.GetString($type.Namespace)
        if ($name -ieq 'NativeStallTrace') { throw 'Core assembly contains restricted native diagnostic tracing.' }
        if ($ns -ceq 'LedgeTop.WindowsDownload' -and $required.ContainsKey($name)) { $required[$name]++ }
      }
      foreach ($handle in $reader.TypeReferences) {
        if ($reader.GetString($reader.GetTypeReference($handle).Name) -ieq 'NativeStallTrace') { throw 'Core assembly references restricted native diagnostic tracing.' }
      }
      foreach ($handle in $reader.ExportedTypes) {
        if ($reader.GetString($reader.GetExportedType($handle).Name) -ieq 'NativeStallTrace') { throw 'Core assembly exports restricted native diagnostic tracing.' }
      }
      foreach ($count in $required.Values) { if ($count -ne 1) { throw 'Core assembly has missing or ambiguous required types.' } }
    } finally { $pe.Dispose() }
  } finally { $stream.Dispose() }
}
if ($AppVersion -cnotmatch '\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z' -or
    @($AppVersion.Split('.') | Where-Object { [int]$_ -gt 65535 }).Count -ne 0) { throw 'Use a canonical four-component unsigned16 version.' }
$PayloadDirectory = LocalPath $PayloadDirectory
$PayloadInventoryPath = LocalPath $PayloadInventoryPath
$BuildReceiptPath = LocalPath $BuildReceiptPath
$SourceRepository = LocalPath $SourceRepository
if (-not [IO.Directory]::Exists($PayloadDirectory) -or -not [IO.Directory]::Exists($SourceRepository)) { throw 'Payload and repository must be directories.' }
$OutputDirectory = LocalPath $OutputDirectory $true
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory must not exist.' }
if ($OutputDirectory.StartsWith($PayloadDirectory+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Output cannot be inside payload.' }
$manifestBytes = BoundedJsonBytes $PayloadInventoryPath 8388608
$manifestHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant()
$inventory = @(JsonBytes $manifestBytes)
$build = Json $BuildReceiptPath 4194304
foreach ($key in @('status','sourceCommit','rid','selfContained','buildMode','compiledReleaseChannels','channel','applicationSha256','helperSha256','payloadFiles','payloadBytes','cloudflaredIncluded','signed','installerMaintenanceProtocol','sourceArchiveSha256','freshGenerationStagingQualified')) {
  if (-not $build.ContainsKey($key)) { throw 'Build receipt lacks required construction evidence.' }
}
foreach ($key in @('status','sourceCommit','rid','buildMode','channel','helperSha256','applicationSha256','sourceArchiveSha256')) {
  # PowerShell comparisons/regexes filter arrays rather than enforcing scalar values.
  # Check JSON types first so a singleton matching array cannot masquerade as evidence.
  if ($build[$key] -isnot [string]) { throw 'Receipt textual fields must be JSON strings.' }
}
foreach ($key in @('compiledReleaseChannels','installerMaintenanceProtocol','payloadFiles')) {
  if ($build[$key] -isnot [long] -and $build[$key] -isnot [int]) { throw 'Receipt count/protocol fields must be JSON integers.' }
}
if (($build.payloadBytes -isnot [long] -and $build.payloadBytes -isnot [int] -and $build.payloadBytes -isnot [double]) -or
    -not [double]::IsFinite([double]$build.payloadBytes) -or [double]$build.payloadBytes -ne [Math]::Truncate([double]$build.payloadBytes)) {
  throw 'Receipt payload length must be a finite integral JSON number.'
}
if ($build.status -cne 'private_connected_staging_pilot' -or $build.sourceCommit -cne $ReviewedCommit -or $build.rid -cne 'win-x64' -or
    $build.selfContained -isnot [bool] -or -not $build.selfContained -or $build.buildMode -cne 'packaged' -or $build.compiledReleaseChannels -ne 1 -or
    $build.channel -cne 'pilot' -or $build.cloudflaredIncluded -isnot [bool] -or -not $build.cloudflaredIncluded -or
    $build.signed -isnot [bool] -or $build.signed -or $build.installerMaintenanceProtocol -ne 1 -or
    $build.freshGenerationStagingQualified -isnot [bool] -or -not $build.freshGenerationStagingQualified -or
    $build.helperSha256 -cne $helperSha -or $build.applicationSha256 -cnotmatch '\A[0-9a-f]{64}\z' -or
    $build.sourceArchiveSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Build receipt is outside the approved unsigned pilot construction scope.' }
if ($inventory.Count -lt 1 -or $inventory.Count -gt 4096) { throw 'Payload inventory count is unsupported.' }
$listed = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$prefixSpellings = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$total = 0L
foreach ($item in $inventory) {
  if ($item -isnot [Collections.IDictionary] -or [string]::Join(',',@($item.Keys | Sort-Object)) -cne 'bytes,path,sha256' -or
      $item.path -isnot [string] -or $item.sha256 -isnot [string] -or $item.sha256 -cnotmatch '\A[0-9a-f]{64}\z' -or
      $item.bytes -isnot [long] -and $item.bytes -isnot [int] -or [long]$item.bytes -lt 0 -or [long]$item.bytes -gt 2147483648) { throw 'Malformed inventory entry.' }
  $relative = RelativePath $item.path
  $item.path = $relative
  if (-not $listed.TryAdd($relative,$item)) { throw 'Duplicate/case-colliding inventory paths.' }
  $prefix = ''
  foreach ($part in $relative.Split('/')) {
    $prefix = if ($prefix) { $prefix+'/'+$part } else { $part }
    $spelling = ''
    if ($prefixSpellings.TryGetValue($prefix,[ref]$spelling)) {
      if ($spelling -cne $prefix) { throw 'Case-inconsistent inventory path prefix.' }
    } else { $prefixSpellings.Add($prefix,$prefix) }
  }
  for ($parent = [IO.Path]::GetDirectoryName($relative.Replace('/','\')); $parent; $parent = [IO.Path]::GetDirectoryName($parent)) { $null = $directories.Add($parent.Replace('\','/')) }
  $path = LocalPath (Join-Path $PayloadDirectory $relative)
  $actual = Get-Item -LiteralPath $path
  if (-not $path.StartsWith($PayloadDirectory+'\',[StringComparison]::OrdinalIgnoreCase) -or $actual.PSIsContainer -or
      $actual.Length -ne $item.bytes -or (Hash $path) -cne $item.sha256) { throw 'Payload bytes differ from inventory.' }
  $total += [long]$item.bytes
  if ($total -gt 1073741824) { throw 'Payload size exceeds the supported installer bound.' }
}
foreach ($directory in $directories) { if ($listed.ContainsKey($directory)) { throw 'File/directory inventory collision.' } }
$pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($PayloadDirectory); $observed = 0; $folderCount = 0
while ($pending.Count -gt 0) {
  $folder = $pending.Pop(); $null = LocalPath $folder
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($folder)) {
    $attributes = [IO.File]::GetAttributes($entry)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Payload contains an alias.' }
    $relative = [IO.Path]::GetRelativePath($PayloadDirectory,$entry).Replace('\','/'); $null = RelativePath $relative
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      if (-not $directories.Contains($relative) -or ++$folderCount -gt 4096) { throw 'Unlisted/empty payload directory.' }
      $pending.Push($entry)
    } else { if (-not $listed.ContainsKey($relative)) { throw 'Unlisted payload file.' }; $observed++ }
  }
}
if ($observed -ne $inventory.Count -or $build.payloadFiles -ne $observed -or $build.payloadBytes -ne $total) { throw 'Receipt/inventory counts or lengths differ.' }
foreach ($required in @('LedgeTop.Files.exe','LedgeTop.Files.dll','LedgeTop.WindowsDownload.dll','LedgeTop.Files.deps.json','LedgeTop.Files.runtimeconfig.json','coreclr.dll','hostfxr.dll','hostpolicy.dll','helper/cloudflared.exe','Notices/LICENSE.cloudflared.txt')) {
  if (-not $listed.ContainsKey($required)) { throw 'Required self-contained payload file is missing.' }
}
if ($listed['LedgeTop.Files.dll'].sha256 -cne $build.applicationSha256 -or $listed['helper/cloudflared.exe'].sha256 -cne $helperSha) { throw 'Application/helper receipt pins differ.' }
ApplicationMetadata (Join-Path $PayloadDirectory 'LedgeTop.Files.dll')
AssertCoreHasNoNativeDiagnostics (Join-Path $PayloadDirectory 'LedgeTop.WindowsDownload.dll') $listed['LedgeTop.WindowsDownload.dll'].sha256
$commitType = & git -C $SourceRepository cat-file -t $ReviewedCommit
if ($LASTEXITCODE -ne 0 -or $commitType -cne 'commit') { throw 'Reviewed commit is unavailable.' }
$templateBlob = & git -C $SourceRepository rev-parse "${ReviewedCommit}:apps/windows-download/Packaging/UnsignedInstaller.nsi"
if ($LASTEXITCODE -ne 0 -or $templateBlob -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Installer template must exist in the exact reviewed commit.' }
# Validate the actual executing guard against the same immutable source commit.
$guardStart = [Diagnostics.ProcessStartInfo]::new('git');$guardStart.UseShellExecute=$false;$guardStart.CreateNoWindow=$true;$guardStart.RedirectStandardOutput=$true;$guardStart.RedirectStandardError=$true
foreach ($arg in @('-C',$SourceRepository,'show',"${ReviewedCommit}:scripts/windows-unsigned-installer.ps1")) { $guardStart.ArgumentList.Add($arg) }
$guardProcess=[Diagnostics.Process]::Start($guardStart);$guardMemory=[IO.MemoryStream]::new()
try {
  $guardError=$guardProcess.StandardError.ReadToEndAsync();$guardProcess.StandardOutput.BaseStream.CopyTo($guardMemory);$guardProcess.WaitForExit();$null=$guardError.GetAwaiter().GetResult()
  if ($guardProcess.ExitCode -ne 0 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($guardMemory.ToArray())).ToLowerInvariant() -cne (Hash $PSCommandPath)) { throw 'Builder must match the exact reviewed commit.' }
} finally { $guardMemory.Dispose();$guardProcess.Dispose() }
AssertInventoryUnchanged
if ($ValidateOnly) {
  [ordered]@{status='unsigned_installer_inputs_validated';sourceCommit=$ReviewedCommit;templateBlob=$templateBlob;payloadFiles=$observed;payloadBytes=$total;installedInventoryLeaf=$inventoryLeaf;installedInventorySha256=$manifestHash;installerOwnedSidecarFiles=1;compilerInvoked=$false;installed=$false;signed=$false} | ConvertTo-Json
  return
}
$CompilerRoot = LocalPath $CompilerRoot
$compiler = LocalPath (Join-Path $CompilerRoot 'Bin/makensis.exe')
$copying = LocalPath (Join-Path $CompilerRoot 'COPYING')
$compilerArchive = LocalPath (Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($CompilerRoot))) 'nsis-3.13.zip')
if ((Hash $compiler) -cne $compilerSha -or (Hash $compilerArchive) -cne $archiveSha -or (Hash $copying) -cne $copyingSha) { throw 'Pinned NSIS compiler/archive/license differs.' }
# Verify every extracted toolchain file against the already pinned original ZIP, including stubs/includes/plugins.
$archive = [IO.Compression.ZipFile]::OpenRead($compilerArchive)
try {
  $toolFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith('/')) { continue }
    $entryPath = LocalPath (Join-Path ([IO.Path]::GetDirectoryName($CompilerRoot)) $entry.FullName)
    $null = $toolFiles.Add($entryPath)
    $stream = $entry.Open()
    try { $expected = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() } finally { $stream.Dispose() }
    if ((Get-Item -LiteralPath $entryPath).Length -ne $entry.Length -or (Hash $entryPath) -cne $expected) { throw 'NSIS extracted toolchain changed.' }
  }
  $toolFolders = [Collections.Generic.Stack[string]]::new(); $toolFolders.Push($CompilerRoot)
  while ($toolFolders.Count -gt 0) {
    $folder = $toolFolders.Pop(); $null = LocalPath $folder
    foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($folder)) {
      $null = LocalPath $path
      if ([IO.Directory]::Exists($path)) { $toolFolders.Push($path) }
      elseif (-not $toolFiles.Remove($path)) { throw 'Unlisted extracted compiler file.' }
    }
  }
  if ($toolFiles.Count -ne 0) { throw 'Extracted compiler file missing.' }
} finally { $archive.Dispose() }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$templatePath = Join-Path $OutputDirectory 'UnsignedInstaller.nsi'
$start = [Diagnostics.ProcessStartInfo]::new('git'); $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
foreach ($arg in @('-C',$SourceRepository,'show',"${ReviewedCommit}:apps/windows-download/Packaging/UnsignedInstaller.nsi")) { $start.ArgumentList.Add($arg) }
$process = [Diagnostics.Process]::Start($start)
try {
  $errorTask = $process.StandardError.ReadToEndAsync()
  $output = [IO.FileStream]::new($templatePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $process.StandardOutput.BaseStream.CopyTo($output) } finally { $output.Dispose() }
  $process.WaitForExit(); $null = $errorTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw 'Exact-commit template extraction failed.' }
} finally { $process.Dispose() }
AssertInventoryUnchanged
$sidecarPath=Join-Path $OutputDirectory $inventoryLeaf
$sidecarStream=[IO.File]::Open($sidecarPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $sidecarStream.Write($manifestBytes);$sidecarStream.Flush($true) } finally { $sidecarStream.Dispose() }
$includePath = Join-Path $OutputDirectory 'Payload.nsh'
$lines = [Collections.Generic.List[string]]::new(); $lines.Add('; Generated only from the verified exact inventory. No runtime wildcard paths.')
$lines.Add('!macro InstallPayload')
foreach ($item in ($inventory | Sort-Object path)) {
  $relative = $item.path.Replace('/','\'); $parent = [IO.Path]::GetDirectoryName($relative); $leaf = [IO.Path]::GetFileName($relative)
  $destination = if ($parent) { '$INSTDIR\'+(NsisLiteral $parent) } else { '$INSTDIR' }
  $lines.Add('  SetOutPath "'+$destination+'"')
  $lines.Add('  File "/oname='+(NsisLiteral $leaf)+'" "'+(NsisLiteral (Join-Path $PayloadDirectory $relative))+'"')
}
$lines.Add('  SetOutPath "$INSTDIR"')
$lines.Add('  File "/oname='+$inventoryLeaf+'" "'+(NsisLiteral $sidecarPath)+'"')
$lines.Add('!macroend'); $lines.Add('!macro DeletePayload')
foreach ($item in ($inventory | Sort-Object path)) { $lines.Add('  Delete "$INSTDIR\'+(NsisLiteral $item.path.Replace('/','\'))+'"') }
$lines.Add('  Delete "$INSTDIR\'+$inventoryLeaf+'"')
$lines.Add('!macroend'); $lines.Add('!macro RemovePayloadDirectories')
foreach ($directory in ($directories | Sort-Object @{Expression={($_ -split '/').Count};Descending=$true},@{Expression={$_};Descending=$true})) { $lines.Add('  RMDir "$INSTDIR\'+(NsisLiteral $directory.Replace('/','\'))+'"') }
$lines.Add('!macroend'); $lines.Add('!macro ValidatePayloadPaths')
$lines.Add('  Push "$INSTDIR"'); $lines.Add('  Call un.CheckPayloadPath')
foreach ($directory in ($directories | Sort-Object)) {
  $lines.Add('  Push "$INSTDIR\'+(NsisLiteral $directory.Replace('/','\'))+'"')
  $lines.Add('  Call un.CheckPayloadPath')
}
$lines.Add('  Call un.CheckInventorySidecarPath')
$lines.Add('!macroend'); [IO.File]::WriteAllLines($includePath,$lines,[Text.UTF8Encoding]::new($true))
Copy-Item -LiteralPath $copying -Destination (Join-Path $OutputDirectory 'COPYING.NSIS.txt')
$installer = Join-Path $OutputDirectory "LedgeTop-Files-Pilot-$AppVersion-unsigned-setup.exe"
$oldNsis = $env:NSISDIR; $oldConf = $env:NSISCONFDIR
try {
  $env:NSISDIR=$CompilerRoot; $env:NSISCONFDIR=$CompilerRoot
  & $compiler /NOCONFIG /WX /V3 "/DAPP_VERSION=$AppVersion" "/DOUTPUT_FILE=$installer" "/DSOURCE_COMMIT=$ReviewedCommit" "/DPAYLOAD_MANIFEST_SHA256=$manifestHash" "/DPAYLOAD_INCLUDE=$includePath" $templatePath *> (Join-Path $OutputDirectory 'compile.log')
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($installer)) { throw 'Unsigned installer compilation failed; inspect retained compile.log.' }
} finally { $env:NSISDIR=$oldNsis; $env:NSISCONFDIR=$oldConf }
# Refuse a concurrent payload change; leave the unexecuted result as held evidence on any failure.
foreach ($item in $inventory) { $path=LocalPath (Join-Path $PayloadDirectory $item.path); if ((Hash $path) -cne $item.sha256) { throw 'Payload changed during compilation; output is not qualified.' } }
AssertInventoryUnchanged
if ((Hash $sidecarPath) -cne $manifestHash -or (Get-Item $sidecarPath).Length -ne $manifestBytes.Length) { throw 'Installer inventory snapshot changed during compilation.' }
$anchor="LedgeTop.Files.Payload/1:${manifestHash}:$ReviewedCommit"
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($installer).Comments -cne $anchor) { throw 'Compiled installer inventory/source anchor differs.' }
$receipt = [ordered]@{
  schemaVersion=1;status='unsigned_manual_pilot_installer_constructed';sourceCommit=$ReviewedCommit;sourceArchiveSha256=$build.sourceArchiveSha256
  appVersion=$AppVersion;channel='pilot';buildMode='packaged';installerMaintenanceProtocol=1;templateBlob=$templateBlob;templateSha256=(Hash $templatePath)
  builderSha256=(Hash $PSCommandPath);payloadInventorySha256=$manifestHash;buildReceiptSha256=(Hash $BuildReceiptPath);payloadIncludeSha256=(Hash $includePath)
  payloadFiles=$observed;payloadBytes=$total;applicationSha256=$build.applicationSha256;helperSha256=$helperSha
  installedInventoryLeaf=$inventoryLeaf;installedInventorySha256=$manifestHash;installedInventoryBytes=$manifestBytes.Length;installerOwnedSidecarFiles=1;installedPayloadFiles=($observed+1);installerPeComments=$anchor
  compilerVersion='3.13';compilerSha256=$compilerSha;compilerArchiveSha256=$archiveSha;nsisCopyingSha256=$copyingSha
  installerPath=$installer;installerBytes=(Get-Item -LiteralPath $installer).Length;installerSha256=(Hash $installer)
  signed=$false;installed=$false;uninstalled=$false;published=$false;autoUpdateEnabled=$false;forceShutdown=$false;executedApplication=$false
  scope='Construction and byte/metadata checks only; no installed/runtime/upgrade/uninstall qualification or publisher trust claim.'
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'installer-build-receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 5
