import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
// Read-only validation only: never weakens or repairs the operator's ACL.
const WINDOWS_ACL = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$item = Get-Item -LiteralPath $env:LTDS_MACHINE_PRIVATE_FILE -Force
$cursor = $item
while ($null -ne $cursor) {
 if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
 if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
}
if ($item.PSIsContainer) { exit 1 }
$acl = Get-Acl -LiteralPath $item.FullName
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) { exit 1 }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$seen = @{}
foreach ($rule in $rules) {
 $sid = $rule.IdentityReference.Value
 if ($sid -notin @($user, 'S-1-5-18') -or $seen.ContainsKey($sid) -or $rule.IsInherited -or
     $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
     $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
     $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
     $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { exit 1 }
 $seen[$sid] = $true
}
if (-not $seen.ContainsKey($user)) { exit 1 }
`;

async function privateFile(file, stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20000) throw Error();
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) || stat.uid !== process.getuid()) throw Error();
    return;
  }
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL], {
    shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096,
    env: { SystemRoot: process.env.SystemRoot, LTDS_MACHINE_PRIVATE_FILE: file },
  });
}

/** Every request reloads a strictly private regular file; atomic rotation is supported. */
export async function readMachineCredential(file) {
  const before = await lstat(file);
  await privateFile(file, before);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (before.ino !== opened.ino || before.dev !== opened.dev || before.size !== opened.size) throw Error();
    const buffer = Buffer.alloc(20001);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 20000) throw Error();
    const after = await lstat(file);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error();
    await privateFile(file, after);
    const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'clientId,clientSecret'
      || ![value.clientId, value.clientSecret].every(v => typeof v === 'string' && /^[\x21-\x7e]{1,8192}$/.test(v))) throw Error();
    return value;
  } finally { await handle.close(); }
}
