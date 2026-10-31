param([Parameter(Mandatory=$true)][string]$LiteralDirectory)
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$resolved = (Resolve-Path -LiteralPath $LiteralDirectory).Path
$item = Get-Item -LiteralPath $resolved -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Regular journal directory required' }
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSidValues = @($currentUserSid.Value, 'S-1-5-18', 'S-1-5-32-544')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($currentUserSid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($currentUserSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $resolved -AclObject $acl
$verified = Get-Acl -LiteralPath $resolved
if (-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentUserSid.Value) {
  throw 'Private journal directory owner or inheritance protection failed'
}
$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 3) { throw 'Private journal directory ACL rule count failed' }
$seen = @{}
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Value
  if ($sid -notin $allowedSidValues -or $seen.ContainsKey($sid) -or $rule.IsInherited -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
      $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Private journal directory ACL verification failed' }
  $seen[$sid] = $true
}
if ($seen.Count -ne 3) { throw 'Private journal directory ACL principal verification failed' }
