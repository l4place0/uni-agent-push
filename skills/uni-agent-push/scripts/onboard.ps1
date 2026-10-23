[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
$candidate = if ($env:UNI_PUSH_BIN) { $env:UNI_PUSH_BIN } else { Join-Path $(if ($env:UNI_PUSH_INSTALL_DIR) { $env:UNI_PUSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "UniPush\bin" }) "uni-push.exe" }
if (-not (Test-Path $candidate)) { & (Join-Path $PSScriptRoot "install.ps1") }
& $candidate onboard @CliArgs
exit $LASTEXITCODE
