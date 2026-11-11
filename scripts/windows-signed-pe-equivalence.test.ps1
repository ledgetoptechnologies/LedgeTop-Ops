$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-signed-pe-equivalence.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('lt-signed-pe-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$unsigned=Join-Path $root 'unsigned.bin'; $signed=Join-Path $root 'signed.bin'
try {
  $u=[byte[]]::new(515); $u[0]=0x4d;$u[1]=0x5a;[BitConverter]::GetBytes([uint32]128).CopyTo($u,60)
  [BitConverter]::GetBytes([uint32]0x4550).CopyTo($u,128);[BitConverter]::GetBytes([uint16]224).CopyTo($u,148)
  [BitConverter]::GetBytes([uint16]0x10b).CopyTo($u,152);[BitConverter]::GetBytes([uint32]16).CopyTo($u,244)
  $u[500]=0x77; $u[514]=0x55
  # Synthetic WIN_CERTIFICATE bytes, not a cryptographic signature.
  $s=[byte[]]::new(536);[Array]::Copy($u,$s,$u.Length);$s[216]=0x22
  [BitConverter]::GetBytes([uint32]520).CopyTo($s,280);[BitConverter]::GetBytes([uint32]16).CopyTo($s,284)
  [BitConverter]::GetBytes([uint32]16).CopyTo($s,520);[BitConverter]::GetBytes([uint16]0x200).CopyTo($s,524);[BitConverter]::GetBytes([uint16]2).CopyTo($s,526)
  function Compare-LedgeSynthetic([byte[]]$candidate) {
    [IO.File]::WriteAllBytes($unsigned,$u);[IO.File]::WriteAllBytes($signed,$candidate)
    $a=[IO.File]::Open($unsigned,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try { $b=[IO.File]::Open($signed,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      try { return Test-LedgeSignedPeEquivalent $a $b } finally { $b.Dispose() }
    } finally { $a.Dispose() }
  }
  function Reject([byte[]]$candidate,[string]$name) {
    $failed=$false; try { $null=Compare-LedgeSynthetic $candidate } catch { $failed=$true }
    if (-not $failed) { throw "Invalid synthetic $name was accepted." }
  }
  if (-not (Compare-LedgeSynthetic $s)) { throw 'Valid synthetic structure refused.' }
  $bad=$s.Clone();$bad[500]=0x11;Reject $bad 'overlay mutation'
  $bad=$s.Clone();$bad[515]=1;Reject $bad 'alignment padding'
  $bad=$s.Clone();$bad[526]=1;Reject $bad 'certificate type'
  $bad=$s.Clone();[BitConverter]::GetBytes([uint32]9).CopyTo($bad,520);$bad[530]=1;Reject $bad 'certificate padding'
  $bad=$s.Clone();[BitConverter]::GetBytes([uint32]8).CopyTo($bad,520);Reject $bad 'empty certificate'
  $bad=$s.Clone();[BitConverter]::GetBytes([uint32]519).CopyTo($bad,280);Reject $bad 'certificate offset'
  $bad=[byte[]]::new(537);[Array]::Copy($s,$bad,$s.Length);Reject $bad 'trailing data'
  $bad=$s.Clone();$bad[180]=1;Reject $bad 'header mutation'
  Reject $u 'missing signature table'
  # PE32+ uses a different data-directory offset; overlay remains compared.
  $u64=$u.Clone();[BitConverter]::GetBytes([uint16]240).CopyTo($u64,148);[BitConverter]::GetBytes([uint16]0x20b).CopyTo($u64,152)
  [BitConverter]::GetBytes([uint32]0).CopyTo($u64,244);[BitConverter]::GetBytes([uint32]16).CopyTo($u64,260)
  $s64=[byte[]]::new(536);[Array]::Copy($u64,$s64,$u64.Length);$s64[216]=0x33
  [BitConverter]::GetBytes([uint32]520).CopyTo($s64,296);[BitConverter]::GetBytes([uint32]16).CopyTo($s64,300)
  [BitConverter]::GetBytes([uint32]16).CopyTo($s64,520);[BitConverter]::GetBytes([uint16]0x200).CopyTo($s64,524);[BitConverter]::GetBytes([uint16]2).CopyTo($s64,526)
  $u=$u64
  if (-not (Compare-LedgeSynthetic $s64)) { throw 'Valid synthetic PE32+ structure refused.' }
  $bad=$s64.Clone();$bad[514]=0x44;Reject $bad 'PE32+ overlay mutation'
  Write-Output 'PASS synthetic signed/unsigned PE byte equivalence and overlay/padding/table refusal; no real signature verification.'
} finally {
  if ([IO.File]::Exists($unsigned)) { [IO.File]::Delete($unsigned) }
  if ([IO.File]::Exists($signed)) { [IO.File]::Delete($signed) }
  [IO.Directory]::Delete($root)
}
