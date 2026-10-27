$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $protectedDataAssembly = Join-Path $PSHOME 'System.Security.Cryptography.ProtectedData.dll'
  if (-not (Test-Path -LiteralPath $protectedDataAssembly -PathType Leaf)) { exit 4 }
  Add-Type -Path $protectedDataAssembly
  $inputText = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($inputText) -or $inputText.Length -gt 32768) { exit 2 }
  $request = ConvertFrom-Json -InputObject $inputText -AsHashtable
  if ($request.Keys.Count -ne 3 -or -not $request.ContainsKey('privateKeyPath') -or
      -not $request.ContainsKey('dpapiEntropy') -or -not $request.ContainsKey('payloadBase64')) { exit 2 }
  if (-not [IO.Path]::IsPathFullyQualified([string]$request.privateKeyPath) -or
      [string]$request.dpapiEntropy -notmatch '^.{32,256}$' -or
      [string]$request.payloadBase64 -notmatch '^[A-Za-z0-9+/]+={0,2}$') { exit 2 }
  $protected = [IO.File]::ReadAllBytes([string]$request.privateKeyPath)
  $entropy = [Text.Encoding]::UTF8.GetBytes([string]$request.dpapiEntropy)
  $privateKey = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $payload = [Convert]::FromBase64String([string]$request.payloadBase64)
  $rsa = [Security.Cryptography.RSA]::Create()
  $offset = 0
  $rsa.ImportPkcs8PrivateKey($privateKey, [ref]$offset)
  if ($offset -ne $privateKey.Length -or $rsa.KeySize -lt 3072) { exit 3 }
  try {
    $signature = $rsa.SignData($payload, [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pss)
    [Console]::Out.Write([Convert]::ToBase64String($signature))
  } finally { $rsa.Dispose() }
  [Array]::Clear($privateKey, 0, $privateKey.Length)
  [Array]::Clear($payload, 0, $payload.Length)
  [Array]::Clear($entropy, 0, $entropy.Length)
  [Array]::Clear($protected, 0, $protected.Length)
  exit 0
} catch {
  [Console]::Error.WriteLine('native_staff_bootstrap_owner_signing_failed')
  exit 1
}
