param([Parameter(Mandatory)][string]$PackagedAssembly, [Parameter(Mandatory)][string]$SyntheticAssembly)
$ErrorActionPreference = 'Stop'
# A positive control ensures this fails if the seam name or fixture disappears.
$needle = [Text.Encoding]::ASCII.GetBytes('removeForTests')
function Has-Seam([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($Path))
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    return $text.Contains([Text.Encoding]::ASCII.GetString($needle))
}
if (-not (Has-Seam $SyntheticAssembly)) { throw 'Synthetic positive control does not contain the removal seam.' }
if (Has-Seam $PackagedAssembly) { throw 'Packaged application contains the synthetic removal seam.' }
Write-Output 'PASS packaged application excludes the synthetic removal seam; positive control present.'
