param([Parameter(Mandatory=$true)][string]$LiteralFile)
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$resolvedFile = (Resolve-Path -LiteralPath $LiteralFile).Path
$fileInfo = Get-Item -LiteralPath $resolvedFile -Force
if ($fileInfo.PSIsContainer -or ($fileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Regular authority file required' }
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$privateAcl = [Security.AccessControl.FileSecurity]::new()
$privateAcl.SetOwner($currentUserSid)
$privateAcl.SetAccessRuleProtection($true, $false)
foreach ($allowedSid in @($currentUserSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $privateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($allowedSid, 'FullControl', 'Allow'))
}
Set-Acl -LiteralPath $resolvedFile -AclObject $privateAcl
$verifiedAcl = Get-Acl -LiteralPath $resolvedFile
if (-not $verifiedAcl.AreAccessRulesProtected -or $verifiedAcl.Access.Count -ne 3) { throw 'Private authority ACL verification failed' }
