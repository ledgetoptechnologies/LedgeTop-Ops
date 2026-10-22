param(
  [Parameter(Mandatory)][string]$PackagePath,
  [Parameter(Mandatory)][string]$SignToolPath,
  [Parameter(Mandatory)][string]$ReceiptPath
)

# Construction-only SDK capability probe. Never exports a private key, imports a
# certificate, installs a package, timestamps, or publishes anything.
$ErrorActionPreference = 'Stop'
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function LocalFile([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'An absolute local file is required.' }
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'A fixed local drive is required.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse input paths are unsupported.' }
  }
  if (-not [IO.File]::Exists($full)) { throw 'Input must be a file.' }
  $full
}
$PackagePath = LocalFile $PackagePath
$SignToolPath = LocalFile $SignToolPath
$expectedPackage = 'b7c01c87461471def1a432b2554c2b734aeb9042a4a5e47e5fd00ab4b7b7e472'
if ((Hash $PackagePath) -ne $expectedPackage -or (Get-Item -LiteralPath $PackagePath).Length -ne 83809359) { throw 'Only the reviewed retained unsigned construction package is supported.' }
if ((Hash $SignToolPath) -ne 'd6c04707c59a67fce9fa4bb5fe76c79445b60e1e326d8b500a2f2ba8707c590a') { throw 'SDK SignTool hash differs.' }
$signature = Get-AuthenticodeSignature -LiteralPath $SignToolPath
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate.Subject.Contains('O=Microsoft Corporation')) { throw 'SDK tool signature differs.' }
$ReceiptPath = [IO.Path]::GetFullPath($ReceiptPath)
if ([IO.File]::Exists($ReceiptPath) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($ReceiptPath))) { throw 'Use a fresh receipt in an existing owned directory.' }
$receiptParent = [IO.Path]::GetDirectoryName($ReceiptPath)
if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($receiptParent)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Receipt requires a local fixed drive.' }
for ($part = $receiptParent; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
  if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse receipt paths are unsupported.' }
}
$zip = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
  if ($null -ne $zip.GetEntry('AppxSignature.p7x')) { throw 'Input is already signed.' }
  $readerSettings = [Xml.XmlReaderSettings]::new(); $readerSettings.DtdProcessing = 'Prohibit'; $readerSettings.XmlResolver = $null
  $stream = $zip.GetEntry('AppxManifest.xml').Open()
  try { $reader = [Xml.XmlReader]::Create($stream, $readerSettings); $manifest = [Xml.XmlDocument]::new(); $manifest.XmlResolver = $null; $manifest.Load($reader) } finally { if ($reader) { $reader.Dispose() }; $stream.Dispose() }
  $identity = $manifest.DocumentElement.SelectSingleNode('*[local-name()="Identity"]')
  if ($identity.Name -ne 'LedgeTop.Files.PilotBuildPreview' -or $identity.Publisher -ne 'CN=LedgeTop Build Preview' -or $identity.Version -ne '0.0.0.1' -or $identity.ProcessorArchitecture -ne 'x64') { throw 'Construction identity differs.' }
  $entryCount = $zip.Entries.Count
} finally { $zip.Dispose() }
function CheckLocalDirectory([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($full.StartsWith('\\') -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Temporary storage requires a fixed local drive.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse temporary paths are unsupported.' }
  }
  $full
}
$tempRoot = CheckLocalDirectory ([IO.Path]::GetTempPath())
$leaf = 'ledge-top-signing-rehearsal-' + [Guid]::NewGuid().ToString('N')
$owned = [IO.Path]::GetFullPath((Join-Path $tempRoot $leaf))
[IO.Directory]::CreateDirectory($owned) | Out-Null
$rsa = $null; $certificate = $null; $process = $null
$receipt = [ordered]@{ schema = 1; packageSha256 = $expectedPackage; packageBytes = 83809359; zipEntries = $entryCount; publisher = 'CN=LedgeTop Build Preview'; privateKeyExported = $false; persistentCertificateInstallationRequested = $false; installed = $false; published = $false; timestampRequested = $false; digestCommand = 'sign /fd SHA256 /f public.cer /dg <owned-directory> <owned-copy.msix>'; outcome = 'not-run' }
try {
  $copy = Join-Path $owned 'preview.msix'; [IO.File]::Copy($PackagePath, $copy)
  if ((Hash $copy) -ne $expectedPackage) { throw 'Owned package copy differs.' }
  $receipt.ownedCopyVerified = $true
  $rsa = [Security.Cryptography.RSA]::Create(2048)
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=LedgeTop Build Preview', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
  $oids = [Security.Cryptography.OidCollection]::new(); $oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3')) | Out-Null
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $true))
  $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddHours(1))
  $public = Join-Path $owned 'public.cer'
  [IO.File]::WriteAllBytes($public, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  $info = [Diagnostics.ProcessStartInfo]::new($SignToolPath); $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  foreach ($argument in @('sign','/fd','SHA256','/f',$public,'/dg',$owned,$copy)) { $info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(30000)) { $process.Kill($true); $process.WaitForExit(); throw 'SDK digest probe exceeded 30 seconds.' }
  $receipt.exitCode = $process.ExitCode
  $receipt.output = ($stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()).Replace($owned, '<owned-temp>')
  $receipt.artifacts = @(Get-ChildItem -LiteralPath $owned -File | Where-Object Extension -in '.dig','.p7u','.signed' | ForEach-Object { [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = Hash $_.FullName } })
  $receipt.outcome = if ($process.ExitCode -eq 0) { 'digest-generated-external-signing-not-yet-qualified' } else { 'sdk-digest-generation-rejected' }
  # A generated digest is not signed until its SDK wire format has been qualified.
  # Never fall back to /f PFX, a certificate-store key, or hand-built APPX CMS.
} finally {
  if ($process) { $process.Dispose() }; if ($certificate) { $certificate.Dispose() }; if ($rsa) { $rsa.Dispose() }
  if ([IO.Directory]::Exists($owned)) {
    $resolvedOwned = CheckLocalDirectory $owned
    if ($resolvedOwned -cne $owned -or [IO.Path]::GetDirectoryName($resolvedOwned) -cne $tempRoot -or [IO.Path]::GetFileName($resolvedOwned) -cne $leaf -or $leaf -notmatch '^ledge-top-signing-rehearsal-[0-9a-f]{32}$') { throw 'Cleanup ownership boundary differs.' }
    Remove-Item -LiteralPath $resolvedOwned -Recurse -Force
  }
  $receipt.ownedTempRemoved = -not [IO.Directory]::Exists($owned)
  $receipt.originalPackageUnchanged = (Hash $PackagePath) -eq $expectedPackage
  $receiptBytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 5))
  $receiptStream = [IO.File]::Open($ReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $receiptStream.Write($receiptBytes) } finally { $receiptStream.Dispose() }
}
if (-not $receipt.originalPackageUnchanged -or -not $receipt.ownedTempRemoved) { throw 'Cleanup or original package invariant failed.' }
$receipt | ConvertTo-Json -Depth 5
