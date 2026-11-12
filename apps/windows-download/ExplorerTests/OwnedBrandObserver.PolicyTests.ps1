$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'OwnedBrandObserver.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Observer script does not parse.' }
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-UniqueTestLabel' }, $true))
if ($definitions.Count -ne 1) { throw 'Expected one actual observer wait function.' }
. ([scriptblock]::Create($definitions[0].Extent.Text))
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function ExpectFailure([scriptblock]$action, [string]$message) {
 try { & $action; throw 'Expected failure was absent.' } catch { if ($_.Exception.Message -cne $message) { throw } }
}
$script:observed = 0; $script:identityChecks = 0; $script:pauses = 0
$identity = { $script:identityChecks++ }
$count = { $values = @(0,0,1); $value = $values[$script:observed]; $script:observed++; [int]$value }
$pause = { $script:pauses++ }
$result = Wait-UniqueTestLabel $identity $count $pause 4
Assert ($result -eq 1 -and $script:observed -eq 3 -and $script:identityChecks -eq 4 -and $script:pauses -eq 2) 'Delayed label was not observed with repeated identity fences.'
$script:identityChecks=0; $script:pauses=0
ExpectFailure { Wait-UniqueTestLabel $identity { 2 } $pause 4 } 'The unique test label is ambiguous.'
Assert ($script:identityChecks -eq 1 -and $script:pauses -eq 0) 'Duplicate labels must be rejected immediately.'
$script:identityChecks=0; $script:pauses=0
ExpectFailure { Wait-UniqueTestLabel $identity { 0 } $pause 3 } 'The unique test label did not appear.'
Assert ($script:identityChecks -eq 3 -and $script:pauses -eq 2) 'Missing labels must have bounded retries.'
$script:identityChecks=0
ExpectFailure { Wait-UniqueTestLabel { $script:identityChecks++; if($script:identityChecks -eq 2) { throw 'Changed root or window.' } } { 0 } {} 3 } 'Changed root or window.'
ExpectFailure { Wait-UniqueTestLabel {} { 1 } {} 121 } 'Invalid test label observation bound.'
Write-Output 'PASS unique-label wait: delayed, duplicate, absent and changed-identity cases; no GUI or registration.'
