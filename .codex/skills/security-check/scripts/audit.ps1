[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $AuditArguments
)

$auditScript = Join-Path $PSScriptRoot 'audit.py'
$pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pythonLauncher) {
    & $pythonLauncher.Source -3 -c 'import sys' 2>$null
    if ($LASTEXITCODE -eq 0) {
        & $pythonLauncher.Source -3 $auditScript @AuditArguments
        exit $LASTEXITCODE
    }
}

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    & $python.Source -c 'import sys' 2>$null
    if ($LASTEXITCODE -eq 0) {
        & $python.Source $auditScript @AuditArguments
        exit $LASTEXITCODE
    }
}

Write-Error 'Python 3 is required to run the security audit.'
exit 2
