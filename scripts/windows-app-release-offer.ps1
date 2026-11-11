param(
  [Parameter(Mandatory)][string]$InstallerReceiptPath,
  [Parameter(Mandatory)][string]$InstallerPath,
  [string]$SignedInstallerPath,
  [Parameter(Mandatory)][string]$PayloadAssemblyPath,
  [Parameter(Mandatory)][string]$PayloadBuildReceiptPath,
  [Parameter(Mandatory)][string]$PayloadInventoryPath,
  [Parameter(Mandatory)][ValidateSet('operations','portal')][string]$SiteKind,
  [Parameter(Mandatory)][ValidateSet('pilot')][string]$ApprovedChannel,
  [Parameter(Mandatory)][string]$OutputPath,
  [string]$SourceRepository = ([IO.Path]::GetDirectoryName($PSScriptRoot)),
  [string]$MinSupported = 'Windows 11, 64-bit',
  [string]$Notes = ''
)
# OFFLINE PROPOSED native offer contract. No endpoint/upload/auth/activation,
# signature verification, promotion approval or scheduling. Never executes an app.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($SiteKind -cnotin @('operations','portal') -or $ApprovedChannel -cne 'pilot') { throw 'Use exact lowercase fixed site kind and explicit pilot channel.' }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function LocalPath([string]$Path, [bool]$MissingLeaf = $false) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\') -or
      $Path -match '(^|[\\/])\.{1,2}([\\/]|$)' -or $Path -match '[\x00-\x1f\p{Cf}\p{Cs}]') { throw 'Use a canonical local file path.' }
  $raw = $Path.Replace('/','\'); $root = [IO.Path]::GetPathRoot($raw)
  foreach ($part in $raw.Substring($root.Length).Split('\')) {
    if (-not $part -or $part -match '[<>:"|?*]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
        $part -match '\A(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') { throw 'Unsafe Windows path component.' }
  }
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed -or $full.TrimEnd('\') -eq $root.TrimEnd('\')) { throw 'A dedicated fixed-drive file is required.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    try { $attributes = [IO.File]::GetAttributes($part) }
    catch [IO.FileNotFoundException] { if ($MissingLeaf -and $part -ceq $full) { continue }; throw }
    catch [IO.DirectoryNotFoundException] { if ($MissingLeaf -and $part -ceq $full) { continue }; throw }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Input/output aliases are refused.' }
    if ($part -cne $full -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'A path ancestor changed type.' }
  }
  return $full
}
function UniqueJson($Element) {
  if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $Element.EnumerateObject()) {
      if (-not $names.Add($property.Name)) { throw 'Duplicate or case-ambiguous JSON property.' }
      UniqueJson $property.Value
    }
  } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) { foreach ($item in $Element.EnumerateArray()) { UniqueJson $item } }
}
function ReadJson([string]$Path, [int]$Limit) {
  $info = Get-Item -LiteralPath $Path
  if ($info.PSIsContainer -or $info.Length -lt 1 -or $info.Length -gt $Limit) { throw 'JSON size/type is invalid.' }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { 3 } else { 0 }
  $text = [Text.UTF8Encoding]::new($false,$true).GetString($bytes,$offset,$bytes.Length-$offset)
  $options = [Text.Json.JsonDocumentOptions]::new(); $options.MaxDepth = 32
  $document = [Text.Json.JsonDocument]::Parse($text,$options)
  try {
    if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'A receipt JSON object is required.' }
    UniqueJson $document.RootElement
  } finally { $document.Dispose() }
  return ConvertFrom-Json -InputObject $text -AsHashtable
}
function Integer($Value, [long]$Minimum, [long]$Maximum) {
  if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt $Minimum -or $Value -gt $Maximum) { throw 'A bounded JSON integer is required.' }
}
function VersionText($Value) {
  if ($Value -isnot [string] -or $Value -cnotmatch '\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z' -or
      @($Value.Split('.') | Where-Object { [int]$_ -gt 65535 }).Count) { throw 'Canonical four-u16 Windows version required.' }
}
function SafeText([string]$Value, [int]$Limit) {
  if ($Value.Length -gt $Limit -or $Value -cne $Value.Trim() -or $Value -match '[<>\x00-\x1f\x7f\p{Cf}\p{Cs}]|://|(?i:javascript:)') { throw 'Optional text must be bounded plain text without links/control characters.' }
}
function GitBytes([string[]]$Arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new('git'); $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  foreach ($argument in @('-C',$SourceRepository) + $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($start)
  try {
    $errors = $process.StandardError.ReadToEndAsync(); $bytes = [IO.MemoryStream]::new()
    try { $process.StandardOutput.BaseStream.CopyTo($bytes); $process.WaitForExit(); $null = $errors.GetAwaiter().GetResult(); if ($process.ExitCode -ne 0) { throw 'Exact reviewed source object is unavailable.' }; return ,$bytes.ToArray() }
    finally { $bytes.Dispose() }
  } finally { $process.Dispose() }
}
function Metadata([string]$Path, [string]$ExpectedVersion) {
  Add-Type -AssemblyName System.Reflection.Metadata
  $stream = [IO.File]::OpenRead($Path)
  try {
    $pe = [Reflection.PortableExecutable.PEReader]::new($stream)
    try {
      if (-not $pe.HasMetadata) { throw 'Managed application PE metadata is required.' }
      $reader = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
      $assemblyVersion = $reader.GetAssemblyDefinition().Version.ToString()
      if ($assemblyVersion -cne $ExpectedVersion) { throw 'Actual assembly version differs from the offer.' }
      $channels=[Collections.Generic.List[string]]::new(); $protocols=[Collections.Generic.List[string]]::new(); $fileVersions=[Collections.Generic.List[string]]::new(); $modes=0
      foreach ($handle in $reader.GetAssemblyDefinition().GetCustomAttributes()) {
        $attribute=$reader.GetCustomAttribute($handle)
        if ($attribute.Constructor.Kind.ToString() -cne 'MemberReference') { continue }
        $member=$reader.GetMemberReference([Reflection.Metadata.MemberReferenceHandle]$attribute.Constructor)
        if ($member.Parent.Kind.ToString() -cne 'TypeReference') { continue }
        $type=$reader.GetTypeReference([Reflection.Metadata.TypeReferenceHandle]$member.Parent)
        if ($reader.GetString($type.Namespace) -cne 'System.Reflection') { continue }
        $name=$reader.GetString($type.Name)
        if ($name -cnotin @('AssemblyMetadataAttribute','AssemblyFileVersionAttribute')) { continue }
        $blob=$reader.GetBlobReader($attribute.Value)
        if ($blob.ReadUInt16() -ne 1) { throw 'Malformed application metadata.' }
        if ($name -ceq 'AssemblyFileVersionAttribute') { $fileVersions.Add($blob.ReadSerializedString()); continue }
        $key=$blob.ReadSerializedString(); $value=$blob.ReadSerializedString()
        if ($key -ceq 'LedgeTop.ReleaseChannel') { $channels.Add($value) }
        if ($key -ceq 'LedgeTop.BuildMode') { $modes++ }
        if ($key -ceq 'LedgeTop.InstallerMaintenanceProtocol') { $protocols.Add($value) }
      }
      $resourceVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileVersion
      if ($channels.Count -ne 1 -or $channels[0] -cne 'pilot' -or $protocols.Count -ne 1 -or $protocols[0] -cne '1' -or $modes -ne 0 -or
          $fileVersions.Count -ne 1 -or $fileVersions[0] -cne $ExpectedVersion -or $resourceVersion -cne $ExpectedVersion) { throw 'Actual release channel/protocol/file-version metadata differs.' }
      return @{channel=$channels[0];maintenanceProtocol=1;assemblyVersion=$assemblyVersion;fileVersion=$fileVersions[0];developerMarkerAbsent=$true}
    } finally { $pe.Dispose() }
  } finally { $stream.Dispose() }
}

foreach ($name in @('InstallerReceiptPath','InstallerPath','PayloadAssemblyPath','PayloadBuildReceiptPath','PayloadInventoryPath','SourceRepository')) {
  Set-Variable -Name $name -Value (LocalPath (Get-Variable -Name $name -ValueOnly))
}
if ($SignedInstallerPath) { $SignedInstallerPath = LocalPath $SignedInstallerPath }
if (-not [IO.Directory]::Exists($SourceRepository)) { throw 'Source repository must be a directory.' }
$OutputPath = LocalPath $OutputPath $true
$receiptOutput = LocalPath ($OutputPath + '.construction-receipt.json') $true
if (Test-Path -LiteralPath $OutputPath) { throw 'Offer output must be new; never overwrite immutable metadata.' }
if (Test-Path -LiteralPath $receiptOutput) { throw 'Construction receipt output must be new.' }
if ([IO.Path]::GetExtension($OutputPath) -cne '.json') { throw 'An explicit new JSON output file is required.' }
SafeText $MinSupported 120; SafeText $Notes 600
$receipt = ReadJson $InstallerReceiptPath 1048576
if ($receipt -isnot [Collections.IDictionary]) { throw 'Installer receipt must be a JSON object.' }
foreach ($name in @('status','sourceCommit','sourceArchiveSha256','appVersion','channel','buildMode','templateBlob','templateSha256','builderSha256','payloadInventorySha256','buildReceiptSha256','applicationSha256','installerSha256')) {
  if (-not $receipt.ContainsKey($name) -or $receipt[$name] -isnot [string]) { throw 'Installer receipt textual fields must be scalar strings.' }
}
foreach ($name in @('schemaVersion','installerMaintenanceProtocol','payloadFiles','payloadBytes','installerBytes')) { if (-not $receipt.ContainsKey($name)) { throw 'Installer receipt integer field missing.' } }
Integer $receipt.schemaVersion 1 1; Integer $receipt.installerMaintenanceProtocol 1 1; Integer $receipt.payloadFiles 1 4096
Integer $receipt.payloadBytes 1 1073741824; Integer $receipt.installerBytes 1 1073741824
foreach ($name in @('signed','installed','uninstalled','published','autoUpdateEnabled','forceShutdown','executedApplication')) {
  if (-not $receipt.ContainsKey($name) -or $receipt[$name] -isnot [bool] -or $receipt[$name]) { throw 'Receipt must describe unsigned offline non-executed construction.' }
}
if ($receipt.status -cne 'unsigned_manual_pilot_installer_constructed' -or $receipt.channel -cne $ApprovedChannel -or $receipt.buildMode -cne 'packaged' -or
    $receipt.sourceCommit -cnotmatch '\A[0-9a-f]{40}\z' -or $receipt.templateBlob -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Installer receipt is outside the explicit pilot scope.' }
foreach ($name in @('sourceArchiveSha256','templateSha256','builderSha256','payloadInventorySha256','buildReceiptSha256','applicationSha256','installerSha256')) {
  if ($receipt[$name] -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Receipt digest is invalid.' }
}
VersionText $receipt.appVersion
$version = $receipt.appVersion
$installerInfo = Get-Item -LiteralPath $InstallerPath
if ($installerInfo.PSIsContainer -or $installerInfo.Length -ne $receipt.installerBytes -or (Hash $InstallerPath) -cne $receipt.installerSha256) { throw 'Actual installer bytes differ from construction receipt.' }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($InstallerPath).FileVersion -cne $version) { throw 'Actual installer file version differs.' }
Add-Type -AssemblyName System.Reflection.Metadata
$stream=[IO.File]::OpenRead($InstallerPath)
try { $pe=[Reflection.PortableExecutable.PEReader]::new($stream); try {
  if ($null -eq $pe.PEHeaders.PEHeader -or $pe.PEHeaders.PEHeader.CertificateTableDirectory.Size -ne 0) { throw 'Expected unsigned native installer PE construction.' }
} finally { $pe.Dispose() } } finally { $stream.Dispose() }
if ([IO.Path]::GetFileName($PayloadAssemblyPath) -cne 'LedgeTop.Files.dll' -or (Hash $PayloadAssemblyPath) -cne $receipt.applicationSha256 -or
    (Hash $PayloadBuildReceiptPath) -cne $receipt.buildReceiptSha256 -or (Hash $PayloadInventoryPath) -cne $receipt.payloadInventorySha256) { throw 'Actual payload inputs differ from installer receipt.' }
$observed = Metadata $PayloadAssemblyPath $version
$build = ReadJson $PayloadBuildReceiptPath 4194304
if ($build -isnot [Collections.IDictionary] -or -not $build.ContainsKey('applicationVersion') -or $build.applicationVersion -isnot [string] -or $build.applicationVersion -cne $version -or
    $build.sourceCommit -isnot [string] -or $build.sourceCommit -cne $receipt.sourceCommit -or $build.sourceArchiveSha256 -isnot [string] -or $build.sourceArchiveSha256 -cne $receipt.sourceArchiveSha256) { throw 'Payload build version/source differ.' }
if ([Text.Encoding]::UTF8.GetString((GitBytes @('cat-file','-t',$receipt.sourceCommit))).Trim() -cne 'commit') { throw 'Reviewed source must be an existing commit.' }
$templateBlob=[Text.Encoding]::UTF8.GetString((GitBytes @('rev-parse',($receipt.sourceCommit + ':apps/windows-download/Packaging/UnsignedInstaller.nsi')))).Trim()
$templateBytes=GitBytes @('cat-file','blob',$templateBlob)
if ($templateBlob -cne $receipt.templateBlob -or [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($templateBytes)) -cne $receipt.templateSha256) { throw 'Reviewed template blob differs from construction receipt.' }
$guard=LocalPath (Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1')
$guardBytes=GitBytes @('show',($receipt.sourceCommit + ':scripts/windows-unsigned-installer.ps1'))
if ((Hash $guard) -cne $receipt.builderSha256 -or [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($guardBytes)) -cne $receipt.builderSha256) { throw 'Reviewed read-only input guard differs from the actual builder.' }
# Fixed reviewed guard verifies EVERY payload file/length/hash, helper pin,
# strict receipt types, nondeveloper pilot/protocol1 and exact source/template.
# ValidateOnly neither creates the placeholder directory nor invokes a compiler.
$validationText = & $guard -PayloadDirectory ([IO.Path]::GetDirectoryName($PayloadAssemblyPath)) -PayloadInventoryPath $PayloadInventoryPath -BuildReceiptPath $PayloadBuildReceiptPath `
  -ReviewedCommit $receipt.sourceCommit -AppVersion $version -OutputDirectory ($OutputPath + '.input-validation') -SourceRepository $SourceRepository -ValidateOnly
$validation = ($validationText -join "`n") | ConvertFrom-Json -AsHashtable
if ($validation.status -cne 'unsigned_installer_inputs_validated' -or $validation.sourceCommit -cne $receipt.sourceCommit -or $validation.templateBlob -cne $templateBlob -or
    $validation.payloadFiles -ne $receipt.payloadFiles -or $validation.payloadBytes -ne $receipt.payloadBytes -or $validation.compilerInvoked -isnot [bool] -or $validation.compilerInvoked) { throw 'Read-only payload guard did not confirm exact construction inputs.' }
$distributionPath=$InstallerPath; $distributionBytes=[long]$receipt.installerBytes; $signedCompared=$false
if ($SignedInstallerPath) {
  if ([string]::Equals($SignedInstallerPath,$InstallerPath,[StringComparison]::OrdinalIgnoreCase)) { throw 'The signed copy must be a separate file.' }
  $comparer=LocalPath (Join-Path $PSScriptRoot 'windows-signed-pe-equivalence.ps1')
  $comparerBytes=GitBytes @('show',($receipt.sourceCommit + ':scripts/windows-signed-pe-equivalence.ps1'))
  if ((Hash $comparer) -cne [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($comparerBytes))) { throw 'Reviewed signed PE comparator differs.' }
  . $comparer
  $unsignedStream=[IO.FileStream]::new($InstallerPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $signedStream=[IO.FileStream]::new($SignedInstallerPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
      if (-not (Test-LedgeSignedPeEquivalent $unsignedStream $signedStream)) { throw 'Signed PE comparison failed.' }
      $signedStream.Position=0; $distributionHash=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($signedStream))
      $distributionBytes=[long]$signedStream.Length
    } finally { $signedStream.Dispose() }
  } finally { $unsignedStream.Dispose() }
  $distributionPath=$SignedInstallerPath; $signedCompared=$true
}
$hash = Hash $distributionPath
if (($signedCompared -and $hash -cne $distributionHash) -or (Hash $InstallerPath) -cne $receipt.installerSha256 -or
    (Get-Item -LiteralPath $InstallerPath).Length -ne $receipt.installerBytes -or (Get-Item -LiteralPath $distributionPath).Length -ne $distributionBytes -or
    (Hash $PayloadAssemblyPath) -cne $receipt.applicationSha256) { throw 'Artifact changed during observations.' }
$base = if ($SiteKind -ceq 'operations') { '/api/app' } else { '/api/client/app' }
$offer = [ordered]@{schemaVersion=1;available=$true;platform='windows';channel=$ApprovedChannel;version=$version;sizeBytes=$distributionBytes;sha256=$hash;
  strongETag=('"sha256-' + $hash + '"');sourceCommit=$receipt.sourceCommit;installerType='exe';downloadUrl=($base + '/download/' + $version + '?platform=windows&channel=pilot')}
if ($MinSupported) { $offer.minSupported=$MinSupported }; if ($Notes) { $offer.notes=$Notes }
$bytes=[Text.Encoding]::UTF8.GetBytes(($offer | ConvertTo-Json -Depth 3) + "`n")
$construction=[ordered]@{schemaVersion=1;status='offline_proposed_native_windows_offer_constructed';siteKind=$SiteKind;channel=$ApprovedChannel;version=$version;sourceCommit=$receipt.sourceCommit;
  offerSha256=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes));installerSha256=$hash;installerBytes=$distributionBytes;
  installerReceiptSha256=(Hash $InstallerReceiptPath);payloadBuildReceiptSha256=(Hash $PayloadBuildReceiptPath);payloadInventorySha256=(Hash $PayloadInventoryPath);applicationSha256=$receipt.applicationSha256;
  templateBlob=$templateBlob;observedApplication=$observed;published=$false;endpointImplemented=$false;publisherApprovalProven=$false;signatureTrustVerified=$false;serverStrongETagObserved=$false;
  scope='Proposed metadata only. ETag is valid only if a future artifact server serves these exact bytes with this header. Receipt associations do not independently extract the installer payload or establish promotion/signing approval.'}
if ($signedCompared) {
  $construction['unsignedInstallerSha256']=$receipt.installerSha256
  $construction['signedPeByteEquivalent']=$true
  $construction.scope += ' Signed PE structure and non-signature bytes matched the unsigned construction; Windows signature trust, signer identity, timestamp and promotion remain unverified.'
}
# Recheck no-follow path/absence immediately before exclusive creation. A racing
# output is never overwritten; a write failure leaves new files for owner review.
$null=LocalPath $OutputPath $true; $null=LocalPath $receiptOutput $true
$output=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {
  $sidecar=[IO.FileStream]::new($receiptOutput,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $output.Write($bytes); $output.Flush($true); $receiptBytes=[Text.Encoding]::UTF8.GetBytes(($construction|ConvertTo-Json -Depth 5)+"`n"); $sidecar.Write($receiptBytes); $sidecar.Flush($true) }
  finally { $sidecar.Dispose() }
} finally { $output.Dispose() }
$construction | ConvertTo-Json -Depth 5
