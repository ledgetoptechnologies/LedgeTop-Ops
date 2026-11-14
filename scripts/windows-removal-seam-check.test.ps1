param([Parameter(Mandatory)][string]$PackagedAssembly, [Parameter(Mandatory)][string]$SyntheticAssembly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Reflection.Metadata
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-unsigned-installer.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer parse failed.' }
$function = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'AssertNoSyntheticRemovalSeam' }, $true))
if ($function.Count -ne 1) { throw 'Installer removal seam guard is missing or ambiguous.' }
$metadataFunction = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'ApplicationMetadata' }, $true))
if ($metadataFunction.Count -ne 1 -or @($metadataFunction[0].FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'AssertNoSyntheticRemovalSeam' }, $true)).Count -ne 1) { throw 'Installer metadata validation does not call removal seam guard.' }
Invoke-Expression $function[0].Extent.Text
foreach ($path in @($PackagedAssembly, $SyntheticAssembly)) {
  $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($path))
  try {
    $pe = [Reflection.PortableExecutable.PEReader]::new($stream)
    try {
      if (-not $pe.HasMetadata) { throw 'Test assembly has no metadata.' }
      $reader = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
      $errorSeen = $null
      try { AssertNoSyntheticRemovalSeam $reader } catch { $errorSeen = $_.Exception.Message }
      if ($path -ceq $PackagedAssembly -and $null -ne $errorSeen) { throw "Packaged assembly failed installer guard: $errorSeen" }
      if ($path -ceq $SyntheticAssembly -and $errorSeen -cne 'Payload application contains a forbidden synthetic removal test seam.') { throw "Synthetic assembly did not trigger installer guard: $errorSeen" }
    } finally { $pe.Dispose() }
  } finally { $stream.Dispose() }
}
Write-Output 'PASS installer guard accepts packaged bytes and rejects synthetic removal seam.'
