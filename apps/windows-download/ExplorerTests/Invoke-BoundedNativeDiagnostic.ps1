param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Arguments = '',
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateRange(1, 3600)][int]$ObserveSeconds = 90
)

# A timeout is observation only: do not stop the child or unregister its root.
# Each invocation requires a fresh, caller-owned output directory.
$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Directory]::Exists($directory)) { throw 'Output directory must already exist.' }
$stdout = Join-Path $directory 'stdout.log'
$stderr = Join-Path $directory 'stderr.log'
$receipt = Join-Path $directory 'observation.json'
foreach ($path in @($stdout, $stderr, $receipt)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite $path" }
}
$options = @{
    FilePath = $Executable
    PassThru = $true
    RedirectStandardOutput = $stdout
    RedirectStandardError = $stderr
    WindowStyle = 'Hidden'
}
if ($Arguments) { $options.ArgumentList = $Arguments }
$child = Start-Process @options
# Keep a process handle before a short-lived child exits so Windows PowerShell
# can still obtain its exit code after waiting.
$null = $child.Handle
$start = $child.StartTime.ToUniversalTime().ToString('o')
$exited = $child.WaitForExit($ObserveSeconds * 1000)
$result = [ordered]@{
    processId = $child.Id
    processStartUtc = $start
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    observationTimedOut = -not $exited
    exitCode = if ($exited) { $child.ExitCode } else { $null }
    stdout = $stdout
    stderr = $stderr
}
$result | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
if (-not $exited) {
    Write-Warning "Observation timed out; process $($child.Id) was left running. Preserve its fixture and reconcile before further tests."
    exit 124
}
exit $child.ExitCode
