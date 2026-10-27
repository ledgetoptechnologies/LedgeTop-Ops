$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep this value identical to PINNED_TRUST_CONFIG_SHA256 in the sibling pin
# module. Both are all-zero in source until a separate reviewed provisioning.
$ExpectedTrustConfigSha256 = '0000000000000000000000000000000000000000000000000000000000000000'
$TrustConfigPath = 'C:\Users\fstor\.codex\private\ops-access-group-read\trust.json'
$CapsulePath = 'C:\Users\fstor\.codex\private\ops-access-group-read\access-group-read.dpapi'
$Purpose = 'ltds-ops-access-group-read-capsule-v1'
$SystemSid = 'S-1-5-18'

function Stop-Safe { exit 20 }
function Get-Sha256([byte[]] $Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Assert-NoReparsePath([string] $Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  foreach ($part in $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Safe }
  }
}
function Assert-PrivateAcl([string] $Path, [string] $OwnerSid) {
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $OwnerSid) { Stop-Safe }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { Stop-Safe }
  $expected = @($OwnerSid, $SystemSid) | Sort-Object
  $actual = @()
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.IsInherited) { Stop-Safe }
    $actual += $sid
  }
  if ((@($actual | Sort-Object) -join '|') -ne ($expected -join '|')) { Stop-Safe }
}
function Is-Sha256([string] $Value) { return $Value -cmatch '^[a-f0-9]{64}$' }
function Is-UtcMillis([string] $Value) {
  return $Value -cmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
}

try {
  if (-not (Is-Sha256 $ExpectedTrustConfigSha256) -or $ExpectedTrustConfigSha256 -eq ('0' * 64)) { Stop-Safe }
  Assert-NoReparsePath $TrustConfigPath
  if ((Get-Item -LiteralPath $TrustConfigPath -Force).Length -le 0 -or (Get-Item -LiteralPath $TrustConfigPath -Force).Length -gt 32768) { Stop-Safe }
  $configBytes = [IO.File]::ReadAllBytes($TrustConfigPath)
  if ($configBytes.Length -le 0 -or $configBytes.Length -gt 32768 -or (Get-Sha256 $configBytes) -cne $ExpectedTrustConfigSha256) { Stop-Safe }
  $configText = [Text.UTF8Encoding]::new($false, $true).GetString($configBytes)
  $config = ConvertFrom-Json -InputObject $configText
  $required = @('schemaVersion','purpose','accountId','groupId','groupName','permission','permissionScope','scopeAccountId',
    'tokenNotBefore','tokenExpiresAt','ciphertextSha256','plaintextSha256','ownerSid')
  $actual = @($config.PSObject.Properties.Name)
  if ($actual.Count -ne $required.Count -or (@($actual | Sort-Object) -join '|') -ne (@($required | Sort-Object) -join '|')) { Stop-Safe }
  if ($config.schemaVersion -ne 1 -or $config.purpose -cne $Purpose -or
    $config.accountId -cnotmatch '^[a-f0-9]{32}$' -or
    $config.groupId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
    $config.groupName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$' -or
    $config.permission -cne 'Access:Groups Read' -or $config.permissionScope -cne 'account' -or
    $config.scopeAccountId -cne $config.accountId -or
    -not (Is-Sha256 $config.ciphertextSha256) -or -not (Is-Sha256 $config.plaintextSha256) -or
    $config.ownerSid -cnotmatch '^S-1-5-21-(?:\d+-){2}\d+-\d+$') { Stop-Safe }
  if (-not (Is-UtcMillis $config.tokenNotBefore) -or -not (Is-UtcMillis $config.tokenExpiresAt)) { Stop-Safe }
  $notBefore = [DateTimeOffset]::ParseExact($config.tokenNotBefore, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
  $expires = [DateTimeOffset]::ParseExact($config.tokenExpiresAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
  $now = [DateTimeOffset]::UtcNow
  if ($notBefore -gt $now -or $expires -le $now -or $expires -le $notBefore -or ($expires - $notBefore).TotalHours -gt 24) { Stop-Safe }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $config.ownerSid) { Stop-Safe }

  $root = Split-Path -Parent $TrustConfigPath
  Assert-NoReparsePath $CapsulePath
  Assert-PrivateAcl $root $config.ownerSid
  Assert-PrivateAcl $TrustConfigPath $config.ownerSid
  Assert-PrivateAcl $CapsulePath $config.ownerSid
  if ((Get-Item -LiteralPath $CapsulePath -Force).Length -le 0 -or (Get-Item -LiteralPath $CapsulePath -Force).Length -gt 65536) { Stop-Safe }
  $capsuleBytes = [IO.File]::ReadAllBytes($CapsulePath)
  if ($capsuleBytes.Length -le 0 -or $capsuleBytes.Length -gt 65536 -or (Get-Sha256 $capsuleBytes) -cne $config.ciphertextSha256) { Stop-Safe }
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes($Purpose)
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($capsuleBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  if ($plainBytes.Length -le 0 -or $plainBytes.Length -gt 4096 -or (Get-Sha256 $plainBytes) -cne $config.plaintextSha256) { Stop-Safe }
  $token = [Text.UTF8Encoding]::new($false, $true).GetString($plainBytes)
  if ($token -cnotmatch '^[\x21-\x7e]{20,1024}$') { Stop-Safe }
  $payload = [ordered]@{ schemaVersion = 1; accountId = $config.accountId; groupId = $config.groupId;
    groupName = $config.groupName; token = $token }
  $payloadJson = ConvertTo-Json -InputObject $payload -Compress -Depth 3
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson)))
  exit 0
} catch { Stop-Safe }
finally {
  foreach ($name in @('configBytes','capsuleBytes','plainBytes','entropy')) {
    $value = Get-Variable -Name $name -Scope Script -ErrorAction SilentlyContinue
    if ($null -ne $value -and $value.Value -is [byte[]]) { [Array]::Clear($value.Value, 0, $value.Value.Length) }
  }
  $configText = $null
  $token = $null
}
