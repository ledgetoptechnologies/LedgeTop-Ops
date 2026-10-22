param(
  [Parameter(Mandatory)][switch]$PreviewOnly,
  [Parameter(Mandatory)][string]$PackagePath,
  [Parameter(Mandatory)][string]$UnpackedManifestPath,
  [Parameter(Mandatory)][string]$ConstructionReceiptPath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPackageSha256,
  [Parameter(Mandatory)][string]$DescriptorUrl,
  [Parameter(Mandatory)][string]$PackageUrl,
  [Parameter(Mandatory)][string]$OutputDirectory
)

# Offline construction only. The .xml suffix and reserved .invalid URLs are
# deliberate: this tool cannot produce a usable release/update channel.
$ErrorActionPreference = 'Stop'
if (-not $PreviewOnly) { throw 'Only explicit unsigned preview construction is supported.' }
function LocalExisting([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'Use an absolute local fixed-drive path.' }
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use a local fixed drive.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are not preview inputs.' }
  }
  $full
}
function PreviewUri([string]$Text, [string]$Suffix) {
  $uri = $null
  if ($Text.Length -gt 2084 -or $Text -cnotmatch '\Ahttps://[a-z0-9.-]+/[A-Za-z0-9/_.,-]+\z' -or
      -not [Uri]::TryCreate($Text,[UriKind]::Absolute,[ref]$uri) -or
      $uri.Scheme -cne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
      -not $uri.Host.EndsWith('.invalid',[StringComparison]::Ordinal) -or
      $uri.AbsoluteUri -cne $Text -or $uri.AbsolutePath.Contains('..') -or -not $uri.AbsolutePath.EndsWith($Suffix,[StringComparison]::Ordinal)) {
    throw 'Use a canonical HTTPS reserved .invalid preview URL without credentials, ports, escapes, query or fragment.'
  }
  $uri
}
function XmlDocumentFromStream([IO.Stream]$Stream) {
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $settings.MaxCharactersInDocument = 1048576
  $reader = [Xml.XmlReader]::Create($Stream,$settings)
  try { $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($reader); return ,$document }
  finally { $reader.Dispose() }
}
function Identity($Document) {
  $ns = [Xml.XmlNamespaceManager]::new($Document.NameTable)
  $ns.AddNamespace('p','http://schemas.microsoft.com/appx/manifest/foundation/windows10')
  $nodes = $Document.SelectNodes('/p:Package/p:Identity',$ns)
  if ($nodes.Count -ne 1) { throw 'Exactly one package identity is required.' }
  $node = $nodes[0]
  $identity = [ordered]@{}
  foreach ($name in @('Name','Publisher','Version','ProcessorArchitecture','ResourceId')) { $identity[$name] = $node.GetAttribute($name) }
  if ($identity.Name -cne 'LedgeTop.Files.PilotBuildPreview' -or $identity.Publisher -cne 'CN=LedgeTop Build Preview' -or
      $identity.Version -cnotmatch '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z' -or
      @($identity.Version.Split('.') | Where-Object { [long]$_ -gt 65535 }).Count -gt 0 -or
      $identity.ProcessorArchitecture -cne 'x64' -or $identity.ResourceId -cne '') {
    throw 'Only the existing x64 PilotBuildPreview identity is accepted; no durable publisher/channel is inferred.'
  }
  $identity
}
$PackagePath = LocalExisting $PackagePath
$UnpackedManifestPath = LocalExisting $UnpackedManifestPath
$ConstructionReceiptPath = LocalExisting $ConstructionReceiptPath
$descriptor = PreviewUri $DescriptorUrl '.appinstaller'
$packageUri = PreviewUri $PackageUrl '.msix'
if ($descriptor.Authority -cne $packageUri.Authority) { throw 'Preview descriptor and package must use the same explicit reserved origin.' }
$packageHash = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packageHash -cne $ExpectedPackageSha256) { throw 'Package SHA-256 differs.' }
$construction = Get-Content -LiteralPath $ConstructionReceiptPath -Raw | ConvertFrom-Json
if ($construction.status -cne 'unsigned_local_preview_only' -or $construction.signed -ne $false -or
    $construction.installed -ne $false -or $construction.published -ne $false -or
    $construction.packageSha256 -cne $packageHash -or $construction.packageBytes -ne (Get-Item -LiteralPath $PackagePath).Length -or
    $construction.validatedPack -ne $true -or $construction.unpackedInventoryExact -ne $true) {
  throw 'A matching unsigned construction receipt is required; this is not a release path.'
}
$archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
  if (@($archive.Entries | Where-Object { $_.FullName -ieq 'AppxSignature.p7x' }).Count -ne 0) { throw 'Signed packages are outside this unsigned preview tool.' }
  $entries = @($archive.Entries | Where-Object { $_.FullName -ceq 'AppxManifest.xml' })
  if ($entries.Count -ne 1 -or $entries[0].Length -gt 1048576) { throw 'Package manifest is missing, duplicated or too large.' }
  $stream = $entries[0].Open()
  try { $packagedIdentity = Identity (XmlDocumentFromStream $stream) } finally { $stream.Dispose() }
} finally { $archive.Dispose() }
$stream = [IO.File]::OpenRead($UnpackedManifestPath)
try { $unpackedIdentity = Identity (XmlDocumentFromStream $stream) } finally { $stream.Dispose() }
foreach ($name in $packagedIdentity.Keys) {
  if ($packagedIdentity[$name] -cne $unpackedIdentity[$name]) { throw 'Unpacked identity differs from actual packaged manifest.' }
}
# Never overwrite an existing directory or descriptor, including prior evidence.
if (-not [IO.Path]::IsPathFullyQualified($OutputDirectory) -or (Test-Path -LiteralPath $OutputDirectory)) { throw 'Use a new absolute output directory.' }
$outputParent = LocalExisting ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputDirectory)))
$OutputDirectory = Join-Path $outputParent ([IO.Path]::GetFileName($OutputDirectory))
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$output = Join-Path $OutputDirectory 'LedgeTop.Files.preview.appinstaller.xml'
$settings = [Xml.XmlWriterSettings]::new()
$settings.Encoding = [Text.UTF8Encoding]::new($false)
$settings.Indent = $true
$writer = [Xml.XmlWriter]::Create($output,$settings)
$schema = 'http://schemas.microsoft.com/appx/appinstaller/2021'
try {
  $writer.WriteStartDocument()
  $writer.WriteComment('UNSIGNED OFFLINE CONSTRUCTION PREVIEW. Not for installation, hosting or distribution.')
  $writer.WriteStartElement('AppInstaller',$schema)
  $writer.WriteAttributeString('Version',$packagedIdentity.Version)
  $writer.WriteAttributeString('Uri',$DescriptorUrl)
  $writer.WriteStartElement('MainPackage',$schema)
  foreach ($name in @('Name','Publisher','Version','ProcessorArchitecture')) { $writer.WriteAttributeString($name,$packagedIdentity[$name]) }
  $writer.WriteAttributeString('Uri',$PackageUrl)
  $writer.WriteEndElement()
  $writer.WriteStartElement('UpdateSettings',$schema)
  $writer.WriteStartElement('OnLaunch',$schema)
  $writer.WriteAttributeString('HoursBetweenUpdateChecks','12')
  $writer.WriteAttributeString('ShowPrompt','false')
  $writer.WriteAttributeString('UpdateBlocksActivation','false')
  $writer.WriteEndElement()
  $writer.WriteStartElement('AutomaticBackgroundTask',$schema); $writer.WriteEndElement()
  $writer.WriteEndElement(); $writer.WriteEndElement(); $writer.WriteEndDocument()
} finally { $writer.Dispose() }
$receipt = [ordered]@{
  schemaVersion=1;status='unsigned_offline_descriptor_construction_only';packageSha256=$packageHash
  packageSourceCommit=$construction.sourceCommit
  generatorSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  packageBytes=(Get-Item -LiteralPath $PackagePath).Length;identity=$packagedIdentity;appInstallerNamespace=$schema
  descriptorUrl=$DescriptorUrl;packageUrl=$PackageUrl
  descriptorSha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
  constructionReceiptSha256=(Get-FileHash -LiteralPath $ConstructionReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  onLaunchHours=12;showPrompt=$false;updateBlocksActivation=$false;automaticBackgroundTask=$true;forceUpdateFromAnyVersion=$false
  signed=$false;installed=$false;published=$false;networkRequested=$false;windowsUpdateBehaviorTested=$false
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 4
