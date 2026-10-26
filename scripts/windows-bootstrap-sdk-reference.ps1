param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$DotnetPath,
  [string]$SourcePackagePath,
  [switch]$IncludeRuntimePacks,
  [string]$RuntimePackageDirectory,
  [string]$NoticeDirectory = (Join-Path $PSScriptRoot '../apps/windows-download/Packaging/Notices')
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Build prerequisite only. No app/helper execution, installation, user NuGet
# configuration, credentials, Windows registration, or release publication.
function SafePath([string]$value) {
  if(-not[IO.Path]::IsPathFullyQualified($value)-or$value.StartsWith('\\')){throw 'Use an absolute local path.'}
  $full=[IO.Path]::GetFullPath($value)
  for($part=$full;$null-ne$part;$part=[IO.Path]::GetDirectoryName($part)) {
    if([IO.File]::Exists($part)-or[IO.Directory]::Exists($part)) {
      if(([IO.File]::GetAttributes($part)-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Build prerequisite paths cannot be aliases.'}
    }
  }
  return $full
}
$output=SafePath $OutputDirectory
if(Test-Path -LiteralPath $output){throw 'Build prerequisite output must be new.'}
$dotnet=SafePath $DotnetPath
if(-not[IO.File]::Exists($dotnet)){throw 'Expected the reviewed dotnet executable.'}
$version=& $dotnet --version
if($LASTEXITCODE-ne0-or$version-cne'10.0.402'){throw 'The reviewed .NET SDK 10.0.402 is required.'}
$packageId='microsoft.windows.sdk.net.ref';$packageVersion='10.0.22621.57'
$packageHash='d3d007095a52fcb3dfaf0d091a9912965d9f5e41e223172ed9738436fe2d68b2'
$packageBytes=13116363
$sourceUrl="https://api.nuget.org/v3-flatcontainer/$packageId/$packageVersion/$packageId.$packageVersion.nupkg"
$notices=@(
  @{name='LICENSE.Windows.SDK.rtf';sha256='dd07eb178e00c6bba4148457fc00ff77cd4887eb521d504186fe59c9ec8bbe62'},
  @{name='LICENSE.CsWinRT.txt';sha256='c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
  @{name='THIRD-PARTY-NOTICES.CsWinRT.txt';sha256='5c73ec182c994adc9d90cc576c3188a7f55df4c129a7dfb923e1ce4d91ed154d'}
)
foreach($notice in $notices){
  $file=SafePath (Join-Path $NoticeDirectory $notice.name)
  if(-not[IO.File]::Exists($file)-or(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()-cne$notice.sha256){throw 'Pinned SDK component license differs.'}
}
if($SourcePackagePath){
  $source=SafePath $SourcePackagePath
  if(-not[IO.File]::Exists($source)-or(Get-Item -LiteralPath $source).Length-ne$packageBytes-or
    (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()-cne$packageHash){throw 'Pinned SDK package differs.'}
}
[IO.Directory]::CreateDirectory($output)|Out-Null
$feed=Join-Path $output 'feed';[IO.Directory]::CreateDirectory($feed)|Out-Null
$package=Join-Path $feed "$packageId.$packageVersion.nupkg"
if($SourcePackagePath){Copy-Item -LiteralPath $source -Destination $package}
else{
  $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.UseCookies=$false;$handler.UseDefaultCredentials=$false
  $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(90);$client.MaxResponseContentBufferSize=$packageBytes+1
  try{
    $response=$client.GetAsync($sourceUrl,[Net.Http.HttpCompletionOption]::ResponseContentRead).GetAwaiter().GetResult()
    try{
      if([int]$response.StatusCode-ne200){throw 'Official pinned SDK package download refused.'}
      $bytes=$response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      if($bytes.Length-ne$packageBytes-or[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()-cne$packageHash){throw 'Official pinned SDK package bytes differ.'}
      $stream=[IO.File]::Open($package,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
    }finally{$response.Dispose()}
  }finally{$client.Dispose();$handler.Dispose()}
}
$verification=& $dotnet nuget verify --all $package 2>&1
$verifyExit=$LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $output 'signature-verification.log'),($verification-join"`n"),[Text.UTF8Encoding]::new($false))
if($verifyExit-ne0){throw 'Pinned SDK package signature verification failed; see the retained log.'}
$runtimeReceipts=@()
if($RuntimePackageDirectory-and-not$IncludeRuntimePacks){throw 'Runtime inputs require explicit IncludeRuntimePacks.'}
if($IncludeRuntimePacks){
  $runtimeInputs=@(
    # SDK restore also requests this pack; it is not deployed by this WPF app.
    @{id='microsoft.aspnetcore.app.runtime.win-x64';bytes=12783840;sha256='a0dba5ee37a07a173bc2739f01fee4c530c686e00bf3a3f7508972d6592511f3';notices=@(
      @{entry='LICENSE.txt';name='LICENSE.Microsoft.AspNetCore.App.txt';sha256='d7a68596ab69b06f51ca278a6545148e4269a9381c26d597c13df5d88e08cf5b'},
      @{entry='THIRD-PARTY-NOTICES.TXT';name='THIRD-PARTY-NOTICES.Microsoft.AspNetCore.App.txt';sha256='307d014f65d8482314f1400ddeae7a0cbabb96c2207bcc77f6233cc10588e5d9'})},
    @{id='microsoft.netcore.app.runtime.win-x64';bytes=39979592;sha256='c66885d464697be75676b4d1fbca38b8806f3af01d65d27205b3f06add094444';notices=@(
      @{entry='LICENSE.TXT';name='LICENSE.Microsoft.NETCore.App.txt';sha256='d7a68596ab69b06f51ca278a6545148e4269a9381c26d597c13df5d88e08cf5b'},
      @{entry='THIRD-PARTY-NOTICES.TXT';name='THIRD-PARTY-NOTICES.Microsoft.NETCore.App.txt';sha256='6d15e10a101c6bfff2ab4429ed061bf76c456fc4b23ad6b03e0d0f8377148a21'})},
    @{id='microsoft.windowsdesktop.app.runtime.win-x64';bytes=39195063;sha256='af044758d6bc23eca96b60c9ce13b38f211c3e736eef9458de3cadbbd3e20ff2';notices=@(
      @{entry='LICENSE';name='LICENSE.Microsoft.WindowsDesktop.App.txt';sha256='a89886665765362eb77e0f8e26602c924520041d1711b2eedc136434fe4d01ab'})}
  )
  foreach($runtime in $runtimeInputs){
    $name=$runtime.id+'.10.0.13.nupkg';$target=Join-Path $feed $name
    if($RuntimePackageDirectory){
      $inputPath=SafePath (Join-Path $RuntimePackageDirectory ($runtime.id+'/10.0.13/'+$name))
      if(-not[IO.File]::Exists($inputPath)-or(Get-Item -LiteralPath $inputPath).Length-ne$runtime.bytes){throw 'Pinned runtime package length differs.'}
      $bytes=[IO.File]::ReadAllBytes($inputPath)
    }
    else{
      $url='https://api.nuget.org/v3-flatcontainer/'+$runtime.id+'/10.0.13/'+$name
      $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.UseCookies=$false;$handler.UseDefaultCredentials=$false
      $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(90);$client.MaxResponseContentBufferSize=$runtime.bytes+1
      try{$response=$client.GetAsync($url).GetAwaiter().GetResult();try{if([int]$response.StatusCode-ne200){throw 'Official runtime package download refused.'};$bytes=$response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()}finally{$response.Dispose()}}finally{$client.Dispose();$handler.Dispose()}
    }
    if($bytes.Length-ne$runtime.bytes-or[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()-cne$runtime.sha256){throw 'Pinned runtime package differs.'}
    $stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew);try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
    $verification=& $dotnet nuget verify --all $target 2>&1;$runtimeExit=$LASTEXITCODE
    [IO.File]::WriteAllText((Join-Path $output ($runtime.id+'-signature.log')),($verification-join"`n"))
    if($runtimeExit-ne0){throw 'Pinned runtime signature verification failed.'}
    $zip=[IO.Compression.ZipFile]::OpenRead($target)
    try{foreach($notice in $runtime.notices){
      $entries=@($zip.Entries|Where-Object FullName -CEQ $notice.entry)
      if($entries.Count-ne1-or$entries[0].Length-gt1MB){throw 'Runtime notice entry differs.'}
      $stream=$entries[0].Open();$memory=[IO.MemoryStream]::new();try{$stream.CopyTo($memory);$noticeBytes=$memory.ToArray()}finally{$stream.Dispose();$memory.Dispose()}
      if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($noticeBytes)).ToLowerInvariant()-cne$notice.sha256){throw 'Runtime notice bytes differ.'}
      [IO.File]::WriteAllBytes((Join-Path $output $notice.name),$noticeBytes)
    }}finally{$zip.Dispose()}
    $runtimeReceipts+=@{packageId=$runtime.id;packageVersion='10.0.13';packageBytes=$runtime.bytes;packageSha256=$runtime.sha256;signatureVerificationExitCode=$runtimeExit;licenseFiles=$runtime.notices}
  }
}
foreach($notice in $notices){Copy-Item -LiteralPath (Join-Path $NoticeDirectory $notice.name) -Destination (Join-Path $output $notice.name)}
$escapedFeed=[Security.SecurityElement]::Escape($feed)
$config=Join-Path $output 'NuGet.Config'
[IO.File]::WriteAllText($config,"<?xml version=`"1.0`" encoding=`"utf-8`"?><configuration><packageSources><clear/><add key=`"reviewed-windows-sdk`" value=`"$escapedFeed`"/></packageSources></configuration>",[Text.UTF8Encoding]::new($false))
$receipt=[ordered]@{schemaVersion=1;status='reviewed-sdk-reference-local-feed';packageId=$packageId;packageVersion=$packageVersion;
  packageBytes=$packageBytes;packageSha256=$packageHash;officialSource=$sourceUrl;downloaded=-not[bool]$SourcePackagePath;
  signatureVerificationExitCode=$verifyExit;licenseFiles=$notices;runtimePackages=$runtimeReceipts;nugetConfig=$config;globalSettingsChanged=$false;softwareInstalled=$false}
$json=$receipt|ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $output 'receipt.json'),$json,[Text.UTF8Encoding]::new($false))
$json
