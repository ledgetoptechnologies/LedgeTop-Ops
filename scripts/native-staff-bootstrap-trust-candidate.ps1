$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$privateBytes = $null
$entropyBytes = $null
$protectedBytes = $null
$rsa = $null
$createdDirectory = $false
$createdFiles = [System.Collections.Generic.List[string]]::new()

function Stop-WithCode([string]$Code) {
  [Console]::Error.WriteLine("native_staff_bootstrap_trust_candidate_$Code")
  exit 1
}

function Throw-CandidateCode([string]$Code) {
  throw "CANDIDATE:$Code"
}

function Read-Request {
  $text = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 90000) { Stop-WithCode 'request_invalid' }
  try { $value = ConvertFrom-Json -InputObject $text -AsHashtable } catch { Stop-WithCode 'request_invalid' }
  if ($null -eq $value -or $value -isnot [System.Collections.IDictionary]) { Stop-WithCode 'request_invalid' }
  return $value
}

function Require-ExactKeys($Value, [string[]]$Keys) {
  if ($Value.Count -ne $Keys.Count) { Stop-WithCode 'request_invalid' }
  foreach ($key in $Keys) { if (-not $Value.Contains($key)) { Stop-WithCode 'request_invalid' } }
}

function Get-PrivateCurrentUserAcl {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { Stop-WithCode 'identity_unavailable' }
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($currentSid)
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $full = [Security.AccessControl.FileSystemRights]::FullControl
  $allow = [Security.AccessControl.AccessControlType]::Allow
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, $full, $inherit, $propagation, $allow))
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $full, $inherit, $propagation, $allow))
  return ,$acl
}

function Assert-NoReparsePath([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path -notmatch '^[A-Za-z]:\\') { Stop-WithCode 'path_invalid' }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  $tail = $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)
  foreach ($part in $tail) {
    $current = [IO.Path]::Combine($current, $part)
    if (-not (Test-Path -LiteralPath $current)) { continue }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-WithCode 'path_reparse_refused' }
  }
  return $full
}

function Write-ExclusiveBytes([string]$Path, [byte[]]$Bytes) {
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $createdFiles.Add($Path)
    $stream.Write($Bytes, 0, $Bytes.Length)
    $stream.Flush($true)
  } catch { Throw-CandidateCode 'candidate_write_failed' }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-PrivateCandidateFile([string]$Path, [string[]]$AllowedSids, [string]$OwnerName) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Throw-CandidateCode 'candidate_file_invalid'
  }
  $acl = Get-Acl -LiteralPath $Path
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $explicitRules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  if (
    $acl.AreAccessRulesProtected -or $acl.Owner -ne $OwnerName -or $explicitRules.Count -ne 0 -or $rules.Count -ne 2 -or
    @($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' -or
      $_.IdentityReference.Value -notin $AllowedSids }).Count -ne 0 -or
    @($rules | Select-Object -ExpandProperty IdentityReference | ForEach-Object Value | Sort-Object -Unique).Count -ne 2
  ) {
    Throw-CandidateCode 'candidate_file_acl_invalid'
  }
}

function New-ProtectedDirectory([string]$Path, $Acl) {
  $descriptor = $Acl.GetSecurityDescriptorBinaryForm()
  if (-not [NativeCandidateDirectory]::Create($Path, $descriptor)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 183) { Stop-WithCode 'candidate_exists' }
    Stop-WithCode 'candidate_create_failed'
  }
}

try {
  $protectedDataAssembly = Join-Path $PSHOME 'System.Security.Cryptography.ProtectedData.dll'
  if (-not (Test-Path -LiteralPath $protectedDataAssembly -PathType Leaf)) { Stop-WithCode 'dpapi_unavailable' }
  Add-Type -Path $protectedDataAssembly
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeCandidateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateDirectoryW")]
  private static extern bool CreateDirectoryNative(string path, ref SecurityAttributes attributes);

  public static bool Create(string path, byte[] descriptor) {
    var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var attributes = new SecurityAttributes {
        Length = Marshal.SizeOf<SecurityAttributes>(),
        SecurityDescriptor = pinned.AddrOfPinnedObject(),
        InheritHandle = false
      };
      return CreateDirectoryNative(path, ref attributes);
    } finally { pinned.Free(); }
  }
}
'@
  $request = Read-Request

  if ($request.operation -ceq 'generate') {
    Require-ExactKeys $request @('operation', 'dpapiEntropy')
    if ([string]$request.dpapiEntropy -notmatch '^.{32,256}$') { Stop-WithCode 'request_invalid' }
    $entropyBytes = [Text.Encoding]::UTF8.GetBytes([string]$request.dpapiEntropy)
    $rsa = [Security.Cryptography.RSA]::Create()
    $rsa.KeySize = 3072
    if ($rsa.KeySize -ne 3072) { Stop-WithCode 'key_generation_failed' }
    $privateBytes = $rsa.ExportPkcs8PrivateKey()
    $spki = $rsa.ExportSubjectPublicKeyInfo()
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
      $privateBytes, $entropyBytes, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $publicBase64 = [Convert]::ToBase64String($spki)
    $publicLines = for ($offset = 0; $offset -lt $publicBase64.Length; $offset += 64) {
      $length = [Math]::Min(64, $publicBase64.Length - $offset)
      $publicBase64.Substring($offset, $length)
    }
    $publicPem = "-----BEGIN PUBLIC KEY-----`n$($publicLines -join "`n")`n-----END PUBLIC KEY-----`n"
    $keyId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($spki)).ToLowerInvariant()
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ publicKeyPem = $publicPem;
      keyId = $keyId; protectedPrivateKeyBase64 = [Convert]::ToBase64String($protectedBytes) }))
    exit 0
  }

  if ($request.operation -ceq 'create-candidate') {
    Require-ExactKeys $request @('operation', 'directoryPath', 'configJson', 'configSha256', 'reviewJson',
      'protectedPrivateKeyBase64', 'keyId')
    $directoryPath = Assert-NoReparsePath ([string]$request.directoryPath)
    $parent = [IO.Path]::GetDirectoryName($directoryPath)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Stop-WithCode 'candidate_parent_unavailable' }
    [void](Assert-NoReparsePath $parent)
    $parentInfo = Get-Item -LiteralPath $parent -Force
    if (($parentInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-WithCode 'candidate_parent_invalid' }
    if (Test-Path -LiteralPath $directoryPath) { Stop-WithCode 'candidate_exists' }
    if ($directoryPath -notmatch 'native-staff-bootstrap-trust-candidate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
      Stop-WithCode 'candidate_path_invalid'
    }
    $configBytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$request.configJson)
    $reviewBytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$request.reviewJson)
    if ($configBytes.Length -lt 1 -or $configBytes.Length -gt 32768 -or $reviewBytes.Length -gt 8192 -or
      [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($configBytes)).ToLowerInvariant() -cne [string]$request.configSha256 -or
      [string]$request.keyId -notmatch '^[0-9a-f]{64}$') { Stop-WithCode 'candidate_input_invalid' }
    try { $protectedBytes = [Convert]::FromBase64String([string]$request.protectedPrivateKeyBase64) } catch { Stop-WithCode 'candidate_input_invalid' }
    if ($protectedBytes.Length -lt 64 -or $protectedBytes.Length -gt 16384) { Stop-WithCode 'candidate_input_invalid' }
    try { $review = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false).GetString($reviewBytes)) -AsHashtable }
    catch { Stop-WithCode 'candidate_input_invalid' }
    if ($review.status -cne 'draft-not-approved' -or $review.keyId -cne [string]$request.keyId -or
      $review.configSha256 -cne [string]$request.configSha256) { Stop-WithCode 'candidate_input_invalid' }

    $acl = Get-PrivateCurrentUserAcl
    New-ProtectedDirectory $directoryPath $acl
    $createdDirectory = $true
    $directoryInfo = Get-Item -LiteralPath $directoryPath -Force
    if (-not $directoryInfo.PSIsContainer -or ($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Throw-CandidateCode 'candidate_directory_invalid'
    }
    $createdAcl = Get-Acl -LiteralPath $directoryPath
    if (-not $createdAcl.AreAccessRulesProtected -or $createdAcl.Owner -ne [Security.Principal.WindowsIdentity]::GetCurrent().Name) {
      Throw-CandidateCode 'candidate_acl_invalid'
    }
    $rules = @($createdAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
    if ($rules.Count -ne 2 -or @($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' -or
        $_.IdentityReference.Value -notin $allowedSids }).Count -ne 0 -or
      @($rules | Select-Object -ExpandProperty IdentityReference | ForEach-Object Value | Sort-Object -Unique).Count -ne 2) {
      Throw-CandidateCode 'candidate_acl_invalid'
    }

    $keyPath = Join-Path $directoryPath 'signer-key.dpapi'
    $configPath = Join-Path $directoryPath 'trust-config.candidate.json'
    $reviewPath = Join-Path $directoryPath 'candidate-review.json'
    Write-ExclusiveBytes $keyPath $protectedBytes
    Write-ExclusiveBytes $configPath $configBytes
    Write-ExclusiveBytes $reviewPath $reviewBytes
    $ownerName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    foreach ($candidateFile in @($keyPath, $configPath, $reviewPath)) {
      Assert-PrivateCandidateFile $candidateFile $allowedSids $ownerName
    }
    [Console]::Out.Write('{"created":true}')
    exit 0
  }
  Stop-WithCode 'operation_invalid'
} catch {
  $failureCode = 'candidate_unavailable'
  if ($_.Exception.Message -match '^CANDIDATE:([a-z0-9_]+)$') { $failureCode = $Matches[1] }
  if ($createdDirectory) {
    try {
      $ownedCandidatePath = [IO.Path]::GetFullPath([string]$request.directoryPath)
      $candidateItem = Get-Item -LiteralPath $ownedCandidatePath -Force
      if ($candidateItem.PSIsContainer -and ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        foreach ($file in $createdFiles) {
          $resolvedFile = [IO.Path]::GetFullPath($file)
          if ([IO.Path]::GetDirectoryName($resolvedFile) -ceq $ownedCandidatePath) {
            $fileItem = Get-Item -LiteralPath $resolvedFile -Force -ErrorAction SilentlyContinue
            if ($null -ne $fileItem -and ($fileItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
              [IO.File]::Delete($resolvedFile)
            }
          }
        }
        if (@(Get-ChildItem -LiteralPath $ownedCandidatePath -Force).Count -eq 0) {
          [IO.Directory]::Delete($ownedCandidatePath, $false)
        }
      }
    } catch {}
  }
  Stop-WithCode $failureCode
} finally {
  if ($null -ne $rsa) { $rsa.Dispose() }
  foreach ($bytes in @($privateBytes, $entropyBytes, $protectedBytes)) {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  }
}
