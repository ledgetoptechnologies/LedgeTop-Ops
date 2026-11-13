param(
  [Parameter(Mandatory)][string]$CleanPilotAssembly,
  [Parameter(Mandatory)][string]$SyntheticPilotAssembly
)
$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'windows-package-channel-check.ps1'
$clean = & $checker -AssemblyPath $CleanPilotAssembly -ExpectedChannel pilot | ConvertFrom-Json
if ($clean.channel -cne 'pilot' -or $clean.executedApplication -ne $false) { throw 'Clean package metadata check failed.' }
$refused = $false
try { & $checker -AssemblyPath $SyntheticPilotAssembly -ExpectedChannel pilot | Out-Null }
catch {
  if ($_.Exception.Message -cne 'Package application contains a forbidden synthetic reconnect test seam.') { throw }
  $refused = $true
}
if (-not $refused) { throw 'Synthetic reconnect fixture was not rejected.' }
# Exercise the installer's independently embedded entry point on the same bytes.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer parser failed.' }
foreach ($name in @('AssertNoSyntheticReconnectSeams','ApplicationMetadata')) {
  $found = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
  if ($found.Count -ne 1) { throw "Installer guard $name is missing or ambiguous." }
  Invoke-Expression $found[0].Extent.Text
}
$cleanStream = [IO.File]::OpenRead([IO.Path]::GetFullPath($CleanPilotAssembly))
try {
  $cleanPe = [Reflection.PortableExecutable.PEReader]::new($cleanStream)
  try { AssertNoSyntheticReconnectSeams ([Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($cleanPe)) }
  finally { $cleanPe.Dispose() }
} finally { $cleanStream.Dispose() }
$refused = $false
try { ApplicationMetadata ([IO.Path]::GetFullPath($SyntheticPilotAssembly)) }
catch {
  if ($_.Exception.Message -cne 'Payload application contains a forbidden synthetic reconnect test seam.') { throw }
  $refused = $true
}
if (-not $refused) { throw 'Direct installer metadata guard accepted the synthetic fixture.' }
$singleMethodFixture = Join-Path ([IO.Path]::GetTempPath()) ('lt-single-seam-' + [guid]::NewGuid().ToString('N') + '.dll')
try {
  Add-Type -TypeDefinition 'namespace LedgeTop.Files { public class FreshGenerationOwnedAdapter { public static void CreateForTest() {} } }' -OutputAssembly $singleMethodFixture
  foreach ($guard in @('package','installer')) {
    $refused = $false
    try {
      if ($guard -ceq 'package') { & $checker -AssemblyPath $singleMethodFixture -ExpectedChannel pilot | Out-Null }
      else { ApplicationMetadata $singleMethodFixture }
    } catch {
      $expected = if ($guard -ceq 'package') { 'Package application contains a forbidden synthetic reconnect test seam.' } else { 'Payload application contains a forbidden synthetic reconnect test seam.' }
      if ($_.Exception.Message -cne $expected) { throw }
      $refused = $true
    }
    if (-not $refused) { throw "$guard accepted the isolated adapter authority seam." }
  }
} finally { if ([IO.File]::Exists($singleMethodFixture)) { [IO.File]::Delete($singleMethodFixture) } }
Write-Output 'PASS package and installer metadata guards reject synthetic reconnect fixture without loading application code.'
