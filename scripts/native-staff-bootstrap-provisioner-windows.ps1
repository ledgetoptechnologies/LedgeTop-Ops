$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Stop-WithCode([string]$Code) {
  [Console]::Error.WriteLine("native_staff_bootstrap_provisioner_$Code")
  exit 1
}

function Require-Keys($Value, [string[]]$Keys) {
  if ($null -eq $Value -or $Value -isnot [System.Collections.IDictionary] -or $Value.Count -ne $Keys.Count) {
    Stop-WithCode 'request_invalid'
  }
  foreach ($key in $Keys) { if (-not $Value.Contains($key)) { Stop-WithCode 'request_invalid' } }
}

function Get-AclObject([bool]$Directory) {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $current) { Stop-WithCode 'identity_unavailable' }
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($Directory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($current)
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($Directory) {
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  foreach ($sid in @($current, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,
      [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
      [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  return ,$acl
}

function Assert-ExactAcl([string]$Path, [bool]$Directory) {
  $acl = Get-Acl -LiteralPath $Path
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($currentSid, 'S-1-5-18')
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not $acl.AreAccessRulesProtected -or $owner -cne $currentSid -or $rules.Count -ne 2 -or
      @($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or
        $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $_.IdentityReference.Value -notin $allowed }).Count -ne 0 -or
      @($rules | Select-Object -ExpandProperty IdentityReference | ForEach-Object Value | Sort-Object -Unique).Count -ne 2) {
    Stop-WithCode 'acl_invalid'
  }
  $expectedInheritance = [Security.AccessControl.InheritanceFlags]::None
  if ($Directory) {
    $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  if (@($rules | Where-Object { $_.InheritanceFlags -ne $expectedInheritance -or
      $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None }).Count -ne 0) {
    Stop-WithCode 'acl_invalid'
  }
}

# The existing candidate utility deliberately lets these files inherit their
# owner's protected directory ACL. Do not require a protected file DACL here.
function Assert-CandidatePrivateKeyAcl([string]$Path) {
  $full = Assert-NoReparsePath $Path
  $parent = [IO.Path]::GetDirectoryName($full)
  [void](Assert-NoReparsePath $parent)
  Assert-ExactAcl $parent $true
  $item = Get-Item -LiteralPath $full -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Stop-WithCode 'signer_key_invalid'
  }
  $acl = Get-Acl -LiteralPath $full
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($currentSid, 'S-1-5-18')
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $explicitRules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($acl.AreAccessRulesProtected -or $owner -cne $currentSid -or $explicitRules.Count -ne 0 -or
      $rules.Count -ne 2 -or @($rules | Where-Object { -not $_.IsInherited -or
        $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $_.IdentityReference.Value -notin $allowed -or
        $_.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
        $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None }).Count -ne 0 -or
      @($rules | Select-Object -ExpandProperty IdentityReference | ForEach-Object Value | Sort-Object -Unique).Count -ne 2) {
    Stop-WithCode 'signer_key_acl_invalid'
  }
}

function Assert-NoReparsePath([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { Stop-WithCode 'path_invalid' }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  foreach ($part in $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar,
      [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $part)
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-WithCode 'reparse_refused' }
    }
  }
  return $full
}

function Get-PrivateProvisionerDirectory([string]$Path) {
  $parent = [IO.Path]::GetDirectoryName($Path)
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Stop-WithCode 'parent_unavailable' }
  [void](Assert-NoReparsePath $parent)
  $descriptor = (Get-AclObject $true).GetSecurityDescriptorBinaryForm()
  if (-not [NativeProvisionerFiles]::CreateDirectory($Path, $descriptor)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 183) { Stop-WithCode 'destination_exists' }
    Stop-WithCode 'directory_create_failed'
  }
  Assert-ExactAcl $Path $true
  Flush-Directory ([IO.Path]::GetDirectoryName($Path))
}

function Flush-Directory([string]$Path) {
  $handle = [NativeProvisionerFiles]::OpenDirectory($Path)
  if ($handle.IsInvalid) { $script:directoryFlushSupported = $false; return }
  try {
    if (-not [NativeProvisionerFiles]::Flush($handle)) { $script:directoryFlushSupported = $false }
  } finally { $handle.Dispose() }
}

function Write-ExclusiveDurable([string]$Path, [byte[]]$Bytes) {
  $descriptor = (Get-AclObject $false).GetSecurityDescriptorBinaryForm()
  $handle = [NativeProvisionerFiles]::CreateNewFile($Path, $descriptor)
  if ($handle.IsInvalid) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 80 -or $errorCode -eq 183) { Stop-WithCode 'destination_exists' }
    Stop-WithCode 'file_create_failed'
  }
  try {
    $stream = [IO.FileStream]::new($handle, [IO.FileAccess]::Write)
    $stream.Write($Bytes, 0, $Bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
  } catch { Stop-WithCode 'file_flush_failed' }
  Assert-ExactAcl $Path $false
}

function Publish-NoReplace([string]$Temporary, [string]$Destination) {
  [void](Assert-NoReparsePath $Temporary)
  [void](Assert-NoReparsePath ([IO.Path]::GetDirectoryName($Destination)))
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Temporary)) -ine
      [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination))) { Stop-WithCode 'same_volume_required' }
  if (-not [NativeProvisionerFiles]::MoveNoReplaceWriteThrough($Temporary, $Destination)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 80 -or $errorCode -eq 183) { Stop-WithCode 'destination_exists' }
    Stop-WithCode 'publication_uncertain'
  }
  Flush-Directory ([IO.Path]::GetDirectoryName($Destination))
  Assert-ExactAcl $Destination $false
}

function Get-ReviewedPinsAndVerifyPackage {
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $pinFile = Join-Path $PSScriptRoot 'native-staff-bootstrap-provisioner-pin-value.mjs'
  $pinText = [IO.File]::ReadAllText($pinFile, [Text.UTF8Encoding]::new($false, $true))
  $packageMatch = [regex]::Match($pinText, "PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 = '([0-9a-f]{64})'")
  $configMatch = [regex]::Match($pinText, "PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 = '([0-9a-f]{64})'")
  $receiptMatch = [regex]::Match($pinText, "PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY = '([^']*)'")
  $ownerApprovalText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'native-staff-bootstrap-owner-approval.mjs'),
    [Text.UTF8Encoding]::new($false, $true))
  $issuerConfigMatch = [regex]::Match($ownerApprovalText, "PINNED_TRUST_CONFIG_SHA256 = '([0-9a-f]{64})'")
  if (-not $packageMatch.Success -or -not $configMatch.Success -or -not $receiptMatch.Success -or
      $packageMatch.Groups[1].Value -ceq ('0' * 64)) { Stop-WithCode 'package_pin_not_provisioned' }
  if (-not $issuerConfigMatch.Success -or $configMatch.Groups[1].Value -cne $issuerConfigMatch.Groups[1].Value -or
      $configMatch.Groups[1].Value -ceq ('0' * 64) -or
      -not [IO.Path]::IsPathFullyQualified($receiptMatch.Groups[1].Value)) { Stop-WithCode 'config_pin_not_provisioned' }
  $manifestPath = Join-Path $PSScriptRoot 'native-staff-bootstrap-provisioner-package-manifest.json'
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($manifestBytes)).ToLowerInvariant() -cne
      $packageMatch.Groups[1].Value) { Stop-WithCode 'package_manifest_mismatch' }
  try { $manifest = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes)) -AsHashtable }
  catch { Stop-WithCode 'package_manifest_invalid' }
  if ($manifest.schemaVersion -ne 1 -or $manifest.kind -cne 'operations-native-staff-bootstrap-provisioner-package-v1' -or
      $manifest.files -isnot [array] -or $manifest.files.Count -lt 8 -or $manifest.files.Count -gt 16) {
    Stop-WithCode 'package_manifest_invalid'
  }
  $expectedFiles = @('scripts/native-staff-bootstrap-provisioner.mjs',
    'scripts/native-staff-bootstrap-provisioner-core.mjs',
    'scripts/native-staff-bootstrap-provisioner-package.mjs',
    'scripts/native-staff-bootstrap-provisioner-windows-adapter.mjs',
    'scripts/native-staff-bootstrap-provisioner-windows.ps1',
    'scripts/native-staff-bootstrap-owner-approval.mjs',
    'scripts/native-staff-bootstrap-sign-dpapi.ps1',
    'scripts/native-staff-bootstrap-d1.mjs',
    'scripts/native-staff-bootstrap-owner-approval-distribution-pin.mjs',
    'scripts/native-staff-bootstrap-owner-approval-distribution-pin-value.mjs') | Sort-Object
  $manifestPaths = @($manifest.files | ForEach-Object { [string]$_.path } | Sort-Object)
  if ($manifestPaths.Count -ne $expectedFiles.Count) { Stop-WithCode 'package_manifest_invalid' }
  for ($index = 0; $index -lt $expectedFiles.Count; $index++) {
    if ($manifestPaths[$index] -cne $expectedFiles[$index]) { Stop-WithCode 'package_manifest_invalid' }
  }
  foreach ($entry in $manifest.files) {
    if ($entry.path -isnot [string] -or $entry.sha256 -notmatch '^[0-9a-f]{64}$') { Stop-WithCode 'package_manifest_invalid' }
    $target = [IO.Path]::GetFullPath((Join-Path $root $entry.path))
    if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-WithCode 'package_path_invalid'
    }
    [void](Assert-NoReparsePath $target)
    $bytes = [IO.File]::ReadAllBytes($target)
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $entry.sha256) {
      Stop-WithCode 'package_file_mismatch'
    }
  }
  $script:pins = @{ packageSha256 = $packageMatch.Groups[1].Value
    configSha256 = $configMatch.Groups[1].Value
    receiptDirectory = [IO.Path]::GetFullPath($receiptMatch.Groups[1].Value) }
}

function Write-AtomicNoReplace([string]$Path, [byte[]]$Bytes) {
  $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  Write-ExclusiveDurable $temporary $Bytes
  Flush-Directory ([IO.Path]::GetDirectoryName($Path))
  Publish-NoReplace $temporary $Path
}

function Write-AtomicReplace([string]$Path, [byte[]]$Bytes) {
  $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  Write-ExclusiveDurable $temporary $Bytes
  Flush-Directory ([IO.Path]::GetDirectoryName($Path))
  if (-not [NativeProvisionerFiles]::MoveReplaceWriteThrough($temporary, $Path)) { Stop-WithCode 'journal_update_uncertain' }
  Flush-Directory ([IO.Path]::GetDirectoryName($Path))
  Assert-ExactAcl $Path $false
}

function Get-FixedPaths([string]$LocalAppData) {
  if ([string]::IsNullOrWhiteSpace($LocalAppData) -or -not [IO.Path]::IsPathFullyQualified($LocalAppData)) {
    Stop-WithCode 'local_app_data_unavailable'
  }
  $local = [IO.Path]::GetFullPath($LocalAppData)
  return @{ config = [IO.Path]::Combine($local, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json')
    receipt = [IO.Path]::GetFullPath($script:pins.receiptDirectory)
    journalDirectory = $local
    journal = [IO.Path]::Combine($local, 'native-staff-bootstrap-provisioning-attempt.json')
    lock = [IO.Path]::Combine($local, 'native-staff-bootstrap-provisioning.lock') }
}

function Assert-NoPriorProvisioningAttempt([string]$JournalPath) {
  if (Test-Path -LiteralPath $JournalPath) { Stop-WithCode 'prior_attempt_exists' }
  $directory = [IO.Path]::GetDirectoryName($JournalPath)
  $name = [IO.Path]::GetFileName($JournalPath)
  $pattern = '^' + [regex]::Escape($name) + '\.[0-9a-f]{32}\.tmp$'
  foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -File -ErrorAction Stop)) {
    if ($item.Name -match $pattern) { Stop-WithCode 'prior_attempt_exists' }
  }
}

function Read-Journal {
  if (-not (Test-Path -LiteralPath $script:fixed.journal -PathType Leaf)) { Stop-WithCode 'attempt_missing' }
  [void](Assert-NoReparsePath $script:fixed.journal)
  Assert-ExactAcl $script:fixed.journal $false
  $bytes = [IO.File]::ReadAllBytes($script:fixed.journal)
  if ($bytes.Length -lt 2 -or $bytes.Length -gt 16 * 1024) { Stop-WithCode 'attempt_invalid' }
  try { return ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($bytes)) -AsHashtable }
  catch { Stop-WithCode 'attempt_invalid' }
}

$source = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class NativeProvisionerFiles {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateDirectoryW")]
  private static extern bool CreateDirectoryNative(string path, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
  private static extern SafeFileHandle CreateFileNative(string path, uint access, uint share,
    ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
  private static extern SafeFileHandle OpenFileNative(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="FlushFileBuffers")]
  private static extern bool FlushNative(SafeFileHandle handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="MoveFileExW")]
  private static extern bool MoveFileExNative(string source, string destination, uint flags);

  public static bool CreateDirectory(string path, byte[] descriptor) {
    var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var sa = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(),
        SecurityDescriptor = pin.AddrOfPinnedObject(), InheritHandle = false };
      return CreateDirectoryNative(path, ref sa);
    } finally { pin.Free(); }
  }
  public static SafeFileHandle CreateNewFile(string path, byte[] descriptor) {
    var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var sa = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(),
        SecurityDescriptor = pin.AddrOfPinnedObject(), InheritHandle = false };
      return CreateFileNative(path, 0x40000000, 0, ref sa, 1, 0x80000080, IntPtr.Zero);
    } finally { pin.Free(); }
  }
  public static SafeFileHandle OpenDirectory(string path) => OpenFileNative(path, 0x40000000,
    0x00000007, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
  public static bool Flush(SafeFileHandle handle) => FlushNative(handle);
  public static bool MoveNoReplaceWriteThrough(string source, string destination) => MoveFileExNative(source, destination, 0x8);
  public static bool MoveReplaceWriteThrough(string source, string destination) => MoveFileExNative(source, destination, 0x9);
}
'@
try { Add-Type -TypeDefinition $source -ErrorAction Stop } catch { Stop-WithCode 'windows_primitive_unavailable' }

try {
  $script:directoryFlushSupported = $true
  Get-ReviewedPinsAndVerifyPackage
  $requestText = [Console]::In.ReadToEnd()
  if ($requestText.Length -lt 2 -or $requestText.Length -gt 128 * 1024) { Stop-WithCode 'request_invalid' }
  try { $request = ConvertFrom-Json -InputObject $requestText -AsHashtable } catch { Stop-WithCode 'request_invalid' }
  if ($null -eq $request -or $request -isnot [System.Collections.IDictionary] -or
      -not $request.Contains('operation')) { Stop-WithCode 'request_invalid' }
  $localAppData = $env:LOCALAPPDATA
  $script:fixed = Get-FixedPaths $localAppData
  $journalDirectory = $script:fixed.journalDirectory
  $journalPath = $script:fixed.journal
  $lockPath = $script:fixed.lock

  switch -CaseSensitive ([string]$request.operation) {
    'preflight' {
      Require-Keys $request @('operation', 'paths')
      $paths = $request.paths
      Require-Keys $paths @('configPath', 'receiptDirectory', 'protectedPrivateKeyPath', 'journalPath', 'lockPath')
      $receipt = Assert-NoReparsePath ([string]$paths.receiptDirectory)
      if ([string]$paths.configPath -ine $script:fixed.config -or [string]$paths.journalPath -ine $journalPath -or
          [string]$paths.lockPath -ine $lockPath -or $receipt -ine $script:fixed.receipt) { Stop-WithCode 'fixed_path_mismatch' }
      foreach ($target in @($script:fixed.config, $receipt, $journalPath, $lockPath)) {
        [void](Assert-NoReparsePath $target)
        if (Test-Path -LiteralPath $target) { Stop-WithCode 'existing_path_refused' }
      }
      Assert-NoPriorProvisioningAttempt $journalPath
      $protectedKey = Assert-NoReparsePath ([string]$paths.protectedPrivateKeyPath)
      if (-not (Test-Path -LiteralPath $protectedKey -PathType Leaf)) { Stop-WithCode 'signer_key_unavailable' }
      Assert-CandidatePrivateKeyAcl $protectedKey
      $configParent = [IO.Path]::GetDirectoryName($script:fixed.config)
      if (Test-Path -LiteralPath $configParent) {
        Assert-ExactAcl $configParent $true
        if (@(Get-ChildItem -LiteralPath $configParent -Force).Count -ne 0) { Stop-WithCode 'unexpected_parent_content' }
      }
      [void](Assert-NoReparsePath ([IO.Path]::GetDirectoryName($receipt)))
      [void](Assert-NoReparsePath $journalDirectory)
      [Console]::Out.Write('{"preflight":true}')
    }
    'begin' {
      Require-Keys $request @('operation', 'intent')
      $intent = $request.intent
      Require-Keys $intent @('configPath', 'receiptDirectory', 'journalPath', 'lockPath', 'packageSha256', 'configSha256',
        'sourceCommit', 'initialPayloadSha256', 'startedAt', 'operationId')
      if ([string]$intent.configPath -ine $script:fixed.config -or [string]$intent.journalPath -ine $journalPath -or
          [string]$intent.lockPath -ine $lockPath -or [string]$intent.receiptDirectory -ine $script:fixed.receipt -or
          [string]$intent.packageSha256 -cne $script:pins.packageSha256 -or
          [string]$intent.configSha256 -cne $script:pins.configSha256 -or
          [string]$intent.operationId -notmatch '^[0-9a-f-]{36}$') {
        Stop-WithCode 'fixed_path_mismatch'
      }
      [void](Assert-NoReparsePath $journalDirectory)
      Assert-NoPriorProvisioningAttempt $journalPath
      if (Test-Path -LiteralPath $lockPath) { Stop-WithCode 'prior_attempt_exists' }
      $lockBytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$intent.operationId)
      Write-ExclusiveDurable $lockPath $lockBytes
      Flush-Directory $journalDirectory
      $journal = @{ schemaVersion = 1; kind = 'native-staff-bootstrap-provisioning-attempt-v1'
        operationId = [string]$intent.operationId; packageSha256 = [string]$intent.packageSha256
        configSha256 = [string]$intent.configSha256
        sourceCommit = [string]$intent.sourceCommit; initialPayloadSha256 = [string]$intent.initialPayloadSha256
        configPath = [string]$intent.configPath; receiptDirectory = [string]$intent.receiptDirectory
        phase = 'started'; startedAt = [string]$intent.startedAt }
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $journal -Depth 8 -Compress))
      Write-AtomicNoReplace $journalPath $bytes
      [Console]::Out.Write('{"started":true}')
    }
    'install-config' {
      Require-Keys $request @('operation', 'destination', 'configBase64', 'configSha256')
      if ([string]$request.destination -ine $script:fixed.config) { Stop-WithCode 'fixed_path_mismatch' }
      $bytes = [Convert]::FromBase64String([string]$request.configBase64)
      if ($bytes.Length -lt 1 -or $bytes.Length -gt 32768 -or
          [string]$request.configSha256 -cne $script:pins.configSha256 -or
          [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne [string]$request.configSha256) {
        Stop-WithCode 'config_bytes_invalid'
      }
      $journal = Read-Journal
      if ($journal.phase -cne 'started' -or [string]$journal.configSha256 -cne [string]$request.configSha256) {
        Stop-WithCode 'attempt_phase_invalid'
      }
      $parent = [IO.Path]::GetDirectoryName($script:fixed.config)
      if (-not (Test-Path -LiteralPath $parent)) {
        $grandparent = [IO.Path]::GetDirectoryName($parent)
        if (-not (Test-Path -LiteralPath $grandparent)) { Get-PrivateProvisionerDirectory $grandparent }
        Get-PrivateProvisionerDirectory $parent
      }
      else { Assert-ExactAcl $parent $true }
      Write-AtomicNoReplace $script:fixed.config $bytes
      [Console]::Out.Write('{"configPublished":true}')
    }
    'create-receipt-directory' {
      Require-Keys $request @('operation', 'receiptDirectory')
      $receipt = Assert-NoReparsePath ([string]$request.receiptDirectory)
      $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($journalPath)) -AsHashtable
      if ($receipt -ine [string]$journal.receiptDirectory -or $receipt -ine $script:fixed.receipt -or
          $journal.phase -cne 'config-published') {
        Stop-WithCode 'attempt_phase_invalid'
      }
      $parent = [IO.Path]::GetDirectoryName($receipt)
      if (-not (Test-Path -LiteralPath $parent)) { Stop-WithCode 'receipt_parent_missing' }
      else { [void](Assert-NoReparsePath $parent) }
      if (Test-Path -LiteralPath $receipt) { Stop-WithCode 'receipt_directory_exists' }
      Get-PrivateProvisionerDirectory $receipt
      if (@(Get-ChildItem -LiteralPath $receipt -Force).Count -ne 0) { Stop-WithCode 'receipt_directory_not_empty' }
      [Console]::Out.Write('{"receiptDirectoryCreated":true}')
    }
    'advance-journal' {
      Require-Keys $request @('operation', 'phase')
      if ([string]$request.phase -notin @('config-published', 'receipt-directory-created')) { Stop-WithCode 'phase_invalid' }
      $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($journalPath)) -AsHashtable
      $allowed = @{ 'config-published' = 'started'; 'receipt-directory-created' = 'config-published' }
      if ($journal.phase -cne $allowed[[string]$request.phase]) { Stop-WithCode 'attempt_phase_invalid' }
      $journal.phase = [string]$request.phase
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $journal -Depth 8 -Compress))
      Write-AtomicReplace $journalPath $bytes
      [Console]::Out.Write('{"journalAdvanced":true}')
    }
    'publish-initial-registry' {
      Require-Keys $request @('operation', 'temporary', 'destination')
      $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($journalPath)) -AsHashtable
      $expected = [IO.Path]::Combine([string]$journal.receiptDirectory, 'approval-state.json')
      if ([string]$request.destination -ine $expected -or $journal.phase -cne 'receipt-directory-created') {
        Stop-WithCode 'attempt_phase_invalid'
      }
      $temporary = Assert-NoReparsePath ([string]$request.temporary)
      if ([IO.Path]::GetDirectoryName($temporary) -ine [string]$journal.receiptDirectory -or
          [IO.Path]::GetFileName($temporary) -notmatch '^approval-state\.json\.[0-9a-f-]{36}\.tmp$' -or
          -not (Test-Path -LiteralPath $temporary -PathType Leaf)) { Stop-WithCode 'registry_temporary_invalid' }
      # Node creates and fsyncs the initializer's unique temp file before the
      # publisher callback. Apply the provisioner-owned protected ACL here,
      # before the atomic no-replace move.
      Set-Acl -LiteralPath $temporary -AclObject (Get-AclObject $false)
      Assert-ExactAcl ([string]$request.temporary) $false
      Publish-NoReplace $temporary $expected
      [Console]::Out.Write('{"registryPublished":true}')
    }
    'verify-registry' {
      Require-Keys $request @('operation', 'destination')
      $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($journalPath)) -AsHashtable
      $expected = [IO.Path]::Combine([string]$journal.receiptDirectory, 'approval-state.json')
      if ([string]$request.destination -ine $expected -or -not (Test-Path -LiteralPath $expected -PathType Leaf)) {
        Stop-WithCode 'registry_missing'
      }
      Assert-ExactAcl $expected $false
      $items = @(Get-ChildItem -LiteralPath ([string]$journal.receiptDirectory) -Force)
      if ($items.Count -ne 1 -or $items[0].Name -cne 'approval-state.json') { Stop-WithCode 'registry_directory_not_exact' }
      $rawSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($expected))).ToLowerInvariant()
      [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ registryVerified = $true; registryRawSha256 = $rawSha }))
    }
    'finish' {
      Require-Keys $request @('operation', 'result')
      $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($journalPath)) -AsHashtable
      if ($journal.phase -cne 'receipt-directory-created') { Stop-WithCode 'attempt_phase_invalid' }
      $result = $request.result
      Require-Keys $result @('configSha256', 'registryStateSha256', 'registryRawSha256')
      if ([string]$result.configSha256 -cne [string]$journal.configSha256 -or
          [string]$result.registryStateSha256 -notmatch '^[0-9a-f]{64}$' -or
          [string]$result.registryRawSha256 -notmatch '^[0-9a-f]{64}$') { Stop-WithCode 'result_invalid' }
      $journal.phase = 'complete'
      $journal.registryStateSha256 = [string]$result.registryStateSha256
      $journal.registryRawSha256 = [string]$result.registryRawSha256
      # Persist a conservative fact: write-through rename and file Flush(true) are
      # used, but this implementation does not claim directory-entry flush proof.
      $journal.directoryFlushConfirmed = $false
      $journal.completedAt = [DateTime]::UtcNow.ToString('o')
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $journal -Depth 8 -Compress))
      Write-AtomicReplace $journalPath $bytes
      [IO.File]::Delete($lockPath)
      Flush-Directory $journalDirectory
      [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ complete = $true
        directoryFlushSupported = $script:directoryFlushSupported }))
    }
    'reconcile-read-only' {
      Require-Keys $request @('operation', 'localAppData', 'receiptDirectory')
      $fixed = Get-FixedPaths ([string]$request.localAppData)
      if ([string]$request.receiptDirectory -ine $fixed.receipt) { Stop-WithCode 'fixed_path_mismatch' }
      $statePath = [IO.Path]::Combine([string]$request.receiptDirectory, 'approval-state.json')
      $journal = $null; $stateHash = $null; $configHash = $null
      if (Test-Path -LiteralPath $fixed.journal -PathType Leaf) {
        [void](Assert-NoReparsePath $fixed.journal); Assert-ExactAcl $fixed.journal $false
        $journal = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($fixed.journal)) -AsHashtable
      }
      if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        [void](Assert-NoReparsePath $statePath); Assert-ExactAcl $statePath $false
        $stateHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($statePath))).ToLowerInvariant()
      }
      if (Test-Path -LiteralPath $fixed.config -PathType Leaf) {
        [void](Assert-NoReparsePath $fixed.config); Assert-ExactAcl $fixed.config $false
        $configHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($fixed.config))).ToLowerInvariant()
      }
      [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ readOnly = $true
        phase = if ($null -eq $journal) { 'no-journal' } else { $journal.phase }
        lockPresent = (Test-Path -LiteralPath $fixed.lock -PathType Leaf)
        directoryFlushConfirmed = if ($null -eq $journal) { $null } else { $journal.directoryFlushConfirmed }
        configSha256 = $configHash; registryRawSha256 = $stateHash }))
    }
    default { Stop-WithCode 'operation_invalid' }
  }
} catch {
  if ($_.Exception.Message -match '^native_staff_bootstrap_provisioner_[a-z0-9_]+$') {
    [Console]::Error.WriteLine($_.Exception.Message)
  } else { [Console]::Error.WriteLine('native_staff_bootstrap_provisioner_windows_helper_failed') }
  exit 1
}
