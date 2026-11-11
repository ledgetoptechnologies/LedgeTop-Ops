# Pure file-equivalence check for a signed copy of an already-built PE.
# This does NOT verify an Authenticode signature, publisher, timestamp, or offer.
# The caller must independently hold validated no-follow file handles and verify
# the signature; this helper never invokes or executes either executable.
function Get-LedgePeSigningFields([IO.FileStream]$Stream) {
  $r=[IO.BinaryReader]::new($Stream,[Text.Encoding]::UTF8,$true)
  try {
    if ($Stream.Length -lt 256 -or $Stream.Length -gt 1073741824) { throw 'PE length is unsupported.' }
    $Stream.Position=0
    if ($r.ReadUInt16() -ne 0x5a4d) { throw 'DOS header is invalid.' }
    $Stream.Position=0x3c; $pe=[long]$r.ReadUInt32()
    if ($pe -lt 64 -or $pe -gt ($Stream.Length-256)) { throw 'PE offset is invalid.' }
    $Stream.Position=$pe
    if ($r.ReadUInt32() -ne 0x00004550) { throw 'PE signature is invalid.' }
    $Stream.Position=$pe+20; $optionalSize=[int]$r.ReadUInt16()
    $optional=$pe+24
    if ($optionalSize -lt 144 -or $optional+$optionalSize -gt $Stream.Length) { throw 'PE optional header is invalid.' }
    $Stream.Position=$optional; $magic=$r.ReadUInt16()
    if ($magic -eq 0x10b) { $directoryOffset=96; $countOffset=92 }
    elseif ($magic -eq 0x20b) { $directoryOffset=112; $countOffset=108 }
    else { throw 'Unsupported PE optional header.' }
    if ($optionalSize -lt ($directoryOffset+40)) { throw 'PE security directory is absent.' }
    $Stream.Position=$optional+$countOffset
    if ($r.ReadUInt32() -lt 5) { throw 'PE security directory is absent.' }
    $security=$optional+$directoryOffset+32; $Stream.Position=$security
    return @{ Checksum=($optional+64); Security=$security; CertificateOffset=[long]$r.ReadUInt32(); CertificateSize=[long]$r.ReadUInt32() }
  } finally { $r.Dispose() }
}

function Get-LedgeNormalizedPeHash([IO.FileStream]$Stream,[long]$Length,[long]$Checksum,[long]$Security) {
  $hash=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  try {
    $Stream.Position=0; $position=[long]0; $buffer=[byte[]]::new(65536)
    while ($position -lt $Length) {
      $want=[int][Math]::Min($buffer.Length,$Length-$position); $count=$Stream.Read($buffer,0,$want)
      if ($count -le 0) { throw 'PE was truncated during comparison.' }
      foreach ($range in @(@($Checksum,4),@($Security,8))) {
        $from=[Math]::Max($position,[long]$range[0]); $to=[Math]::Min($position+$count,[long]$range[0]+[long]$range[1])
        if ($to -gt $from) { [Array]::Clear($buffer,[int]($from-$position),[int]($to-$from)) }
      }
      $hash.AppendData($buffer,0,$count); $position += $count
    }
    return ,$hash.GetHashAndReset()
  } finally { $hash.Dispose() }
}

function Test-LedgeSignedPeEquivalent([IO.FileStream]$Unsigned,[IO.FileStream]$Signed) {
  $originalLength=$Unsigned.Length; $signedLength=$Signed.Length
  $u=Get-LedgePeSigningFields $Unsigned; $s=Get-LedgePeSigningFields $Signed
  if ($u.Checksum -ne $s.Checksum -or $u.Security -ne $s.Security -or $u.CertificateOffset -ne 0 -or $u.CertificateSize -ne 0) { throw 'PE signing fields differ.' }
  $aligned=($originalLength+7) -band (-bnot [long]7)
  if ($s.CertificateOffset -ne $aligned -or $s.CertificateSize -lt 8 -or ($s.CertificateSize % 8) -ne 0 -or
      $s.CertificateOffset+$s.CertificateSize -ne $signedLength) { throw 'Signed PE certificate placement is invalid.' }
  $Signed.Position=$originalLength
  for ($i=$originalLength; $i -lt $aligned; $i++) { if ($Signed.ReadByte() -ne 0) { throw 'Nonzero signing alignment padding.' } }
  $reader=[IO.BinaryReader]::new($Signed,[Text.Encoding]::UTF8,$true)
  try {
    $position=$s.CertificateOffset; $entries=0
    while ($position -lt $signedLength) {
      if (++$entries -gt 16) { throw 'Too many certificate entries.' }
      if ($signedLength-$position -lt 8) { throw 'Certificate header is truncated.' }
      $Signed.Position=$position; $length=[long]$reader.ReadUInt32(); $revision=$reader.ReadUInt16(); $type=$reader.ReadUInt16()
      if ($length -le 8 -or $length -gt $signedLength-$position -or $revision -ne 0x0200 -or $type -ne 2) { throw 'Certificate entry is invalid.' }
      $next=($position+$length+7) -band (-bnot [long]7)
      if ($next -gt $signedLength) { throw 'Certificate entry exceeds its table.' }
      $Signed.Position=$position+$length
      while ($Signed.Position -lt $next) { if ($Signed.ReadByte() -ne 0) { throw 'Nonzero certificate padding.' } }
      $position=$next
    }
  } finally { $reader.Dispose() }
  $a=Get-LedgeNormalizedPeHash $Unsigned $originalLength $u.Checksum $u.Security
  $b=Get-LedgeNormalizedPeHash $Signed $originalLength $s.Checksum $s.Security
  if ($Unsigned.Length -ne $originalLength -or $Signed.Length -ne $signedLength -or
      -not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($a,$b)) { throw 'Signed installer differs outside allowed signing fields.' }
  return $true
}
