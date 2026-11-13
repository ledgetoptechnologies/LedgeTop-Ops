param([Parameter(Mandatory)][string]$CleanAssembly, [Parameter(Mandatory)][string]$SyntheticAssembly)
$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'windows-package-channel-check.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer parse failed.' }
$function = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'AssertExplorerHasNoNativeDiagnostics' }, $true))
if ($function.Count -ne 1) { throw 'Explorer installer guard is missing or ambiguous.' }
Invoke-Expression $function[0].Extent.Text
foreach ($path in @($CleanAssembly, $SyntheticAssembly)) {
  $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  foreach ($guard in @('builder','installer')) {
    $errorSeen = $null
    try {
      if ($guard -ceq 'builder') { & $checker -AssemblyPath $path -ExpectedChannel pilot -AssemblyKind Explorer | Out-Null }
      else { AssertExplorerHasNoNativeDiagnostics ([IO.Path]::GetFullPath($path)) $sha }
    } catch { $errorSeen = $_.Exception.Message }
    if ($path -ceq $CleanAssembly -and $null -ne $errorSeen) { throw "Clean Explorer failed $guard guard: $errorSeen" }
    if ($path -ceq $SyntheticAssembly -and $errorSeen -cne 'Explorer application contains a forbidden synthetic ownership test seam.') { throw "Synthetic Explorer failed to trigger $guard guard: $errorSeen" }
  }
}
Write-Output 'PASS builder and installer reject synthetic Explorer ownership methods in exact assembly bytes.'
