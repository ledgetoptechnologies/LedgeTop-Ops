param(
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$NugetPackagesDirectory,
  [string]$SourceNoticeDirectory = (Join-Path $PSScriptRoot '../apps/windows-download/Packaging/Notices')
)

# Copy the vendor's actual notices from the exact signed runtime packages used
# by the qualified self-contained x64 layout. This does not assert that every
# other bundled component's notices are complete, or install/execute anything.
$ErrorActionPreference = 'Stop'
function HashBytes([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function LocalDirectory([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'Use an absolute local directory.' }
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Directory]::Exists($full) -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use an existing local fixed-drive directory.' }
  for ($part = $full; $null -ne $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse directories are not notice inputs.' }
  }
  $full
}
$payload = LocalDirectory $PayloadDirectory
$packages = LocalDirectory $NugetPackagesDirectory
$sourceNotices = LocalDirectory $SourceNoticeDirectory
$frameworks = @((Get-Content -LiteralPath (Join-Path $payload 'LedgeTop.Files.runtimeconfig.json') -Raw | ConvertFrom-Json).runtimeOptions.includedFrameworks)
if ($frameworks.Count -ne 2 -or @($frameworks | Where-Object { $_.version -cne '10.0.13' }).Count -ne 0 -or
    (@($frameworks.name | Sort-Object) -join ',') -cne 'Microsoft.NETCore.App,Microsoft.WindowsDesktop.App') { throw 'Runtime notices require the reviewed self-contained .NET10.0.13 framework pair.' }
$deps = Get-Content -LiteralPath (Join-Path $payload 'LedgeTop.Files.deps.json') -Raw | ConvertFrom-Json
$runtimeLibraries = @($deps.libraries.PSObject.Properties.Name | Where-Object { $_.StartsWith('runtimepack.', [StringComparison]::Ordinal) } | Sort-Object)
if (($runtimeLibraries -join ',') -cne 'runtimepack.Microsoft.NETCore.App.Runtime.win-x64/10.0.13,runtimepack.Microsoft.WindowsDesktop.App.Runtime.win-x64/10.0.13') { throw 'Runtime package references differ from reviewed notice inputs.' }
$inputs = @(
  @{id='microsoft.netcore.app.runtime.win-x64';sha256='c66885d464697be75676b4d1fbca38b8806f3af01d65d27205b3f06add094444';files=@(
    @{entry='LICENSE.TXT';name='LICENSE.Microsoft.NETCore.App.txt';sha256='d7a68596ab69b06f51ca278a6545148e4269a9381c26d597c13df5d88e08cf5b'},
    @{entry='THIRD-PARTY-NOTICES.TXT';name='THIRD-PARTY-NOTICES.Microsoft.NETCore.App.txt';sha256='6d15e10a101c6bfff2ab4429ed061bf76c456fc4b23ad6b03e0d0f8377148a21'})},
  @{id='microsoft.windowsdesktop.app.runtime.win-x64';sha256='af044758d6bc23eca96b60c9ce13b38f211c3e736eef9458de3cadbbd3e20ff2';files=@(
    @{entry='LICENSE';name='LICENSE.Microsoft.WindowsDesktop.App.txt';sha256='a89886665765362eb77e0f8e26602c924520041d1711b2eedc136434fe4d01ab'})}
)
$pending = @()
foreach ($inputPackage in $inputs) {
  $path = Join-Path $packages "$($inputPackage.id)/10.0.13/$($inputPackage.id).10.0.13.nupkg"
  $null = LocalDirectory ([IO.Path]::GetDirectoryName($path))
  if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse package input.' }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $inputPackage.sha256) { throw 'Runtime package hash differs.' }
  $zip = [IO.Compression.ZipFile]::OpenRead($path)
  try {
    foreach ($file in $inputPackage.files) {
      $entries = @($zip.Entries | Where-Object { $_.FullName -ceq $file.entry })
      if ($entries.Count -ne 1 -or $entries[0].Length -gt 1MB) { throw 'Vendor notice is missing, duplicated or oversized.' }
      $stream = $entries[0].Open(); $memory = [IO.MemoryStream]::new()
      try { $stream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
      if ((HashBytes $bytes) -cne $file.sha256) { throw 'Vendor notice hash differs.' }
      $pending += @{name=$file.name;bytes=$bytes;sha256=$file.sha256;packageId=$inputPackage.id;packageSha256=$inputPackage.sha256;entry=$file.entry}
    }
  } finally { $zip.Dispose() }
}
# WindowsDesktop's nupkg omits its third-party notice files. Preserve both
# component source notices from its nuspec's exact dotnet/dotnet commit, rather
# than guessing that NETCore's notice file covers the full desktop payload.
foreach ($file in @(
  @{name='THIRD-PARTY-NOTICES.WPF.txt';sha256='d23dba2fee20c6b59d8f7088ee9ed372459c952a319b7ca90f3eec370cc76eb9';component='wpf'},
  @{name='THIRD-PARTY-NOTICES.WindowsForms.txt';sha256='5a412b38efae0b162dc0893b319023f4cd14a8985a0f9f9ae01ac052b37a36eb';component='winforms'}
)) {
  $path = Join-Path $sourceNotices $file.name
  if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse source notice.' }
  $bytes = [IO.File]::ReadAllBytes($path)
  if ((HashBytes $bytes) -cne $file.sha256) { throw 'Desktop component source notice hash differs.' }
  $pending += @{name=$file.name;bytes=$bytes;sha256=$file.sha256;sourceUrl="https://raw.githubusercontent.com/dotnet/dotnet/4099f83977f4d29604a9aeb971fb0a7bc1d5f699/src/$($file.component)/THIRD-PARTY-NOTICES.TXT"}
}
$noticeDirectory = Join-Path $payload 'Notices'
if (-not [IO.Directory]::Exists($noticeDirectory)) { $null = [IO.Directory]::CreateDirectory($noticeDirectory) }
$null = LocalDirectory $noticeDirectory
foreach ($file in $pending) { if (Test-Path -LiteralPath (Join-Path $noticeDirectory $file.name)) { throw 'Refusing to replace an existing notice.' } }
foreach ($file in $pending) {
  $stream = [IO.File]::Open((Join-Path $noticeDirectory $file.name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($file.bytes) } finally { $stream.Dispose() }
}
[pscustomobject]@{
  schemaVersion=1;runtimeVersion='10.0.13';rid='win-x64';completeThirdPartyAttribution=$false
  notices=@($pending | ForEach-Object { [pscustomobject]@{path="Notices/$($_.name)";bytes=$_.bytes.Length;sha256=$_.sha256;packageId=$_.packageId;packageVersion='10.0.13';packageSha256=$_.packageSha256;packageEntry=$_.entry;sourceUrl=$_.sourceUrl} })
} | ConvertTo-Json -Depth 5
