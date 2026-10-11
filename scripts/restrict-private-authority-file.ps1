param([Parameter(Mandatory=$true)][string]$LiteralFile)
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$resolvedFile = (Resolve-Path -LiteralPath $LiteralFile).Path
$fileInfo = Get-Item -LiteralPath $resolvedFile -Force
if ($fileInfo.PSIsContainer -or ($fileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Regular authority file required' }
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSidValues = @($currentUserSid.Value, 'S-1-5-18', 'S-1-5-32-544')
function Test-ExactPrivateAuthorityAcl([Security.AccessControl.FileSecurity]$Acl) {
  if (-not $Acl.AreAccessRulesProtected -or $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentUserSid.Value) { return $false }
  $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 3) { return $false }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($sid -notin $allowedSidValues -or $seen.ContainsKey($sid) -or $rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false }
    $seen[$sid] = $true
  }
  return $seen.Count -eq 3
}
$existingAcl = Get-Acl -LiteralPath $resolvedFile
if (Test-ExactPrivateAuthorityAcl $existingAcl) { return }
$privateAcl = [Security.AccessControl.FileSecurity]::new()
$privateAcl.SetOwner($currentUserSid)
$privateAcl.SetAccessRuleProtection($true, $false)
foreach ($allowedSid in @($currentUserSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $privateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($allowedSid, 'FullControl', 'Allow'))
}
Set-Acl -LiteralPath $resolvedFile -AclObject $privateAcl
$verifiedAcl = Get-Acl -LiteralPath $resolvedFile
if (-not (Test-ExactPrivateAuthorityAcl $verifiedAcl)) { throw 'Private authority ACL verification failed' }
