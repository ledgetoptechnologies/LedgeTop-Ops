param(
  [Parameter(Mandatory)][string]$AssemblyPath,
  [Parameter(Mandatory)][ValidateSet('pilot','stable')][string]$ExpectedChannel
)

# Offline package-build guard only: inspect PE metadata without loading or
# executing application code. This is not signature/helper/origin verification.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Reflection.Metadata
$stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($AssemblyPath))
try {
  $pe = [System.Reflection.PortableExecutable.PEReader]::new($stream)
  try {
    if (-not $pe.HasMetadata) { throw 'Package application has no managed metadata.' }
    $metadata = [System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
    $channels = [Collections.Generic.List[string]]::new()
    foreach ($handle in $metadata.GetAssemblyDefinition().GetCustomAttributes()) {
      $attribute = $metadata.GetCustomAttribute($handle)
      if ($attribute.Constructor.Kind.ToString() -ne 'MemberReference') { continue }
      $member = $metadata.GetMemberReference([System.Reflection.Metadata.MemberReferenceHandle]$attribute.Constructor)
      if ($member.Parent.Kind.ToString() -ne 'TypeReference') { continue }
      $type = $metadata.GetTypeReference([System.Reflection.Metadata.TypeReferenceHandle]$member.Parent)
      if ($metadata.GetString($type.Namespace) -cne 'System.Reflection' -or
          $metadata.GetString($type.Name) -cne 'AssemblyMetadataAttribute') { continue }
      $blob = $metadata.GetBlobReader($attribute.Value)
      if ($blob.ReadUInt16() -ne 1) { throw 'Package application metadata is malformed.' }
      $key = $blob.ReadSerializedString()
      $value = $blob.ReadSerializedString()
      if ($key -ceq 'LedgeTop.ReleaseChannel') { $channels.Add($value) }
    }
    if ($channels.Count -ne 1 -or $channels[0] -cne $ExpectedChannel) {
      throw 'Package application must contain exactly one matching compiled release channel.'
    }
  } finally { $pe.Dispose() }
} finally { $stream.Dispose() }
[pscustomobject]@{
  channel = $ExpectedChannel
  assemblySha256 = (Get-FileHash -LiteralPath $AssemblyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  executedApplication = $false
  signatureVerified = $false
} | ConvertTo-Json -Compress
