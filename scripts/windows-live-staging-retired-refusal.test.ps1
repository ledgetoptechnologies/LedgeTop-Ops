param(
  [Parameter(Mandatory)][string]$DotnetPath,
  [Parameter(Mandatory)][string]$HarnessDll
)
$ErrorActionPreference = 'Stop'
$DotnetPath = (Resolve-Path -LiteralPath $DotnetPath).Path
$HarnessDll = (Resolve-Path -LiteralPath $HarnessDll).Path
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('lt-live-refusal-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $cases = @(
    @{ Args = @() },
    @{ Args = @('--phase','interrupt','--mode','employee','--run-id','11111111-1111-4111-8111-111111111111',
      '--helper',(Join-Path $fixture 'missing-helper.exe'),'--sha256',('0' * 64),'--selection','synthetic') }
  )
  foreach ($case in $cases) {
    $start = [Diagnostics.ProcessStartInfo]::new($DotnetPath)
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['LOCALAPPDATA'] = $fixture
    $start.ArgumentList.Add($HarnessDll)
    foreach ($value in $case.Args) { $start.ArgumentList.Add($value) }
    $process = [Diagnostics.Process]::Start($start)
    try {
      $stdoutTask = $process.StandardOutput.ReadToEndAsync()
      $stderrTask = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit(15000)) { $process.Kill($true); $process.WaitForExit(); throw 'Harness did not exit.' }
      $stdout = $stdoutTask.GetAwaiter().GetResult()
      $stderr = $stderrTask.GetAwaiter().GetResult()
      if ($process.ExitCode -ne 1 -or $stdout -ne '') { throw 'Unexpected harness exit or stdout.' }
      $result = $stderr | ConvertFrom-Json
      if ($result.schemaVersion -ne 1 -or $result.outcome -cne 'staging-source-not-qualified' -or $result.stage -cne 'Startup') {
        throw 'Harness did not refuse before setup.'
      }
      if (@(Get-ChildItem -LiteralPath $fixture -Force).Count -ne 0) { throw 'Harness wrote to the isolated local state directory.' }
    } finally { $process.Dispose() }
  }
  Write-Output 'PASS: retired staging source refused before argument validation and local setup.'
} finally {
  if ((Test-Path -LiteralPath $fixture) -and @(Get-ChildItem -LiteralPath $fixture -Force).Count -eq 0) {
    Remove-Item -LiteralPath $fixture
  }
}
