param(
  [Parameter(Mandatory=$true)][string]$LiteralParent,
  [string]$LiteralChild,
  [string]$LiteralFile
)
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$expectedParent = [IO.Path]::GetFullPath('C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031')
$expectedChild = [IO.Path]::Combine($expectedParent, 'staging-v4-migrations')
$script:ExpectedJournalSids = $null
if ([IO.Path]::GetFullPath($LiteralParent) -ne $expectedParent) { throw 'Unexpected fixed journal parent' }

function Assert-NoReparsePoint([string]$LiteralPath, [bool]$Directory) {
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (([bool]$item.PSIsContainer) -ne $Directory -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Journal path must be a regular non-reparse filesystem object'
  }
  return $item
}

function Assert-PrivateAcl([string]$LiteralPath, [ValidateSet('Parent','InheritedDirectory','InheritedFile')][string]$Kind) {
  $isDirectory = $Kind -ne 'InheritedFile'
  $item = Assert-NoReparsePoint $LiteralPath $isDirectory
  $acl = Get-Acl -LiteralPath $LiteralPath
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid) {
    throw 'Journal path owner does not match current user'
  }
  if ($Kind -eq 'Parent' -and -not $acl.AreAccessRulesProtected) { throw 'Private journal parent ACL is not protected' }
  if ($Kind -ne 'Parent' -and $acl.AreAccessRulesProtected) { throw 'Journal child ACL must inherit from its private parent' }

  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $expectedSids = if ($Kind -eq 'Parent') {
    $allowedParentSids = @($ownerSid, 'S-1-5-18', 'S-1-5-32-544')
    $parentPrincipals = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    if (@($parentPrincipals | Where-Object { $_ -notin $allowedParentSids }).Count -gt 0 -or
        $ownerSid -notin $parentPrincipals -or 'S-1-5-18' -notin $parentPrincipals -or
        'S-1-5-32-544' -in $parentPrincipals -and $parentPrincipals.Count -lt 3) {
      throw 'Private journal parent must contain owner and SYSTEM, with Administrators only if already present'
    }
    if ($parentPrincipals.Count -notin @(2,3)) { throw 'Private journal parent ACL rule count mismatch' }
    $script:ExpectedJournalSids = @($parentPrincipals | Sort-Object)
    $script:ExpectedJournalSids
  } else {
    if ($null -eq $script:ExpectedJournalSids) { throw 'Private journal parent ACL must be checked first' }
    $script:ExpectedJournalSids
  }
  if ($rules.Count -ne $expectedSids.Count) { throw 'Private journal ACL rule count mismatch' }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($sid -notin $expectedSids -or $seen.ContainsKey($sid) -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      throw 'Private journal ACL contains an unexpected rule'
    }
    if ($Kind -eq 'Parent') {
      $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
      if ($rule.IsInherited -or $rule.InheritanceFlags -ne $expectedInheritance) { throw 'Private parent must have explicit inheritable rules' }
    } else {
      if (-not $rule.IsInherited) { throw 'Journal child rules must be inherited' }
      if ($Kind -eq 'InheritedDirectory') {
        $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        if ($rule.InheritanceFlags -ne $expectedInheritance) { throw 'Journal directory inheritance flags mismatch' }
      } elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
        throw 'Journal file inheritance flags mismatch'
      }
    }
    $seen[$sid] = $true
  }
  $seenPrincipals = (@($seen.Keys | Sort-Object) -join ',')
  $expectedPrincipals = (@($expectedSids | Sort-Object) -join ',')
  if ($seenPrincipals -ne $expectedPrincipals) {
    throw 'Private journal ACL principal set mismatch'
  }
}

Assert-PrivateAcl $LiteralParent 'Parent'
if ($LiteralChild) {
  if ([IO.Path]::GetFullPath($LiteralChild) -ne $expectedChild) { throw 'Unexpected fixed journal child' }
  Assert-PrivateAcl $LiteralChild 'InheritedDirectory'
}
if ($LiteralFile) {
  $filePath = [IO.Path]::GetFullPath($LiteralFile)
  $fileName = [IO.Path]::GetFileName($filePath)
  if (-not $LiteralChild -or [IO.Path]::GetDirectoryName($filePath) -ne $expectedChild -or
      $fileName -notmatch '^[a-f0-9]{32}\.(attempt|postcheck)\.json$') {
    throw 'Journal file must be a direct child of the fixed journal directory'
  }
  Assert-PrivateAcl $LiteralFile 'InheritedFile'
}
