$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'SyntheticJobContainment.cs')
$marker=Join-Path ([IO.Path]::GetTempPath()) ('LedgeTop-JobFixture-'+[guid]::NewGuid().ToString('N')+'.txt')
$pwsh=(Get-Process -Id $PID).Path
if(Test-Path -LiteralPath $marker){throw 'Fixture exists.'}
try {
  $code = '$child=Start-Process -FilePath $PSHOME\pwsh.exe -ArgumentList ''-NoProfile'',''-NonInteractive'',''-Command'',''Start-Sleep -Seconds 60'' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText($env:LEDGETOP_JOB_TEST_MARKER,[string]$child.Id); Start-Sleep -Seconds 60'
  $previous=$env:LEDGETOP_JOB_TEST_MARKER
  try {
    $env:LEDGETOP_JOB_TEST_MARKER=$marker
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $result=[SyntheticJobContainment]::Run($pwsh,('-NoProfile -NonInteractive -EncodedCommand '+$encoded),5000,5000)
  } finally { $env:LEDGETOP_JOB_TEST_MARKER=$previous }
  if (-not $result.TimedOut -or $result.ActiveAfterDrain -ne 0 -or -not (Test-Path -LiteralPath $marker)) {throw 'Timeout/tree drain verification failed.'}
  $childId=0; if (-not [int]::TryParse([IO.File]::ReadAllText($marker),[ref]$childId) -or $childId -le 0) {throw 'Child marker invalid.'}
  if (Get-Process -Id $childId -ErrorAction SilentlyContinue) {throw 'Synthetic descendant remains alive.'}
  $quick=[SyntheticJobContainment]::Run($pwsh,'-NoProfile -NonInteractive -Command exit',5000,5000)
  if($quick.TimedOut -or $quick.ExitCode -ne 0 -or $quick.ActiveAfterDrain -ne 0){throw 'Normal exit verification failed.'}
  $lateMarker=Join-Path ([IO.Path]::GetTempPath()) ('LedgeTop-JobLate-'+[guid]::NewGuid().ToString('N')+'.txt')
  $oldLate=$env:LEDGETOP_JOB_LATE_MARKER
  try {
    $env:LEDGETOP_JOB_LATE_MARKER=$lateMarker
    $lateCode='$child=Start-Process -FilePath $PSHOME\pwsh.exe -ArgumentList ''-NoProfile'',''-NonInteractive'',''-Command'',''Start-Sleep -Seconds 60'' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText($env:LEDGETOP_JOB_LATE_MARKER,[string]$child.Id); exit 0'
    $lateEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lateCode))
    $refused=$false
    try { [void][SyntheticJobContainment]::Run($pwsh,('-NoProfile -NonInteractive -EncodedCommand '+$lateEncoded),5000,1000) }
    catch { if($_.Exception.InnerException -is [TimeoutException] -and $_.Exception.InnerException.Message -eq 'Owned job did not drain; reconcile fixture.') {$refused=$true} else {throw} }
    if(-not $refused -or -not (Test-Path -LiteralPath $lateMarker)){throw 'Parent exit with live child was not refused.'}
    $lateId=0; if(-not [int]::TryParse([IO.File]::ReadAllText($lateMarker),[ref]$lateId) -or $lateId -le 0){throw 'Invalid live child marker.'}
    if(Get-Process -Id $lateId -ErrorAction SilentlyContinue){throw 'Emergency cleanup left descendant running.'}
  } finally { $env:LEDGETOP_JOB_LATE_MARKER=$oldLate; if(Test-Path -LiteralPath $lateMarker){Remove-Item -LiteralPath $lateMarker} }
  $ownerMarker=Join-Path ([IO.Path]::GetTempPath()) ('LedgeTop-JobOwner-'+[guid]::NewGuid().ToString('N')+'.txt')
  $library=(Resolve-Path (Join-Path $PSScriptRoot 'SyntheticJobContainment.cs')).Path
  $target='$child=Start-Process -FilePath $PSHOME\pwsh.exe -ArgumentList ''-NoProfile'',''-NonInteractive'',''-Command'',''Start-Sleep -Seconds 60'' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText($env:LEDGETOP_JOB_OWNER_MARKER,[string]$child.Id); Start-Sleep -Seconds 60'
  $oldLib=$env:LEDGETOP_JOB_TEST_LIB; $oldMarker=$env:LEDGETOP_JOB_OWNER_MARKER; $oldEncoded=$env:LEDGETOP_JOB_TEST_ENCODED
  $owner=$null
  try {
    $env:LEDGETOP_JOB_TEST_LIB=$library; $env:LEDGETOP_JOB_OWNER_MARKER=$ownerMarker
    $env:LEDGETOP_JOB_TEST_ENCODED=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($target))
    $ownerCode='Add-Type -Path $env:LEDGETOP_JOB_TEST_LIB; [SyntheticJobContainment]::Run((Get-Process -Id $PID).Path,(''-NoProfile -NonInteractive -EncodedCommand ''+$env:LEDGETOP_JOB_TEST_ENCODED),60000,5000)'
    $ownerEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ownerCode))
    $owner=Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$ownerEncoded) -WindowStyle Hidden -PassThru
    $deadline=[Diagnostics.Stopwatch]::StartNew()
    while(-not (Test-Path -LiteralPath $ownerMarker)) { if($owner.HasExited -or $deadline.ElapsedMilliseconds -gt 10000){throw 'Owned supervisor did not create marker.'}; Start-Sleep -Milliseconds 50 }
    $descendantId=0; if(-not [int]::TryParse([IO.File]::ReadAllText($ownerMarker),[ref]$descendantId) -or $descendantId -le 0){throw 'Invalid descendant marker.'}
    $descendant=Get-Process -Id $descendantId -ErrorAction Stop
    try {
      $null=$descendant.Handle
      $owner.Kill(); if(-not $owner.WaitForExit(5000)){throw 'Owned supervisor did not exit.'}
      if(-not $descendant.WaitForExit(5000)){throw 'Job descendant survived owner exit.'}
    } finally { $descendant.Dispose() }
  } finally {
    if($owner){if(-not $owner.HasExited){$owner.Kill();[void]$owner.WaitForExit(5000)};$owner.Dispose()}
    $env:LEDGETOP_JOB_TEST_LIB=$oldLib; $env:LEDGETOP_JOB_OWNER_MARKER=$oldMarker; $env:LEDGETOP_JOB_TEST_ENCODED=$oldEncoded
    if(Test-Path -LiteralPath $ownerMarker){Remove-Item -LiteralPath $ownerMarker}
  }
  Write-Output 'PASS suspended assign-before-resume; timeout and owner exit terminate descendants; normal exit drains job.'
} finally { if(Test-Path -LiteralPath $marker){Remove-Item -LiteralPath $marker} }
