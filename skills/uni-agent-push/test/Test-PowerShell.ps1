$ErrorActionPreference = "Stop"
$files = @("install.ps1", "update.ps1", "onboard.ps1", "issue.ps1")
foreach ($file in $files) {
  $path = Join-Path $PSScriptRoot "..\scripts\$file"
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -ne 0) { throw "$file has PowerShell parse errors: $errors" }
}
Write-Output "PowerShell thin scripts parse successfully"
