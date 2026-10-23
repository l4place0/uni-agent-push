[CmdletBinding()]
param(
  [string]$Config,
  [string]$Output = ("uni-push-issue-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + ".md")
)
$binary = if ($env:UNI_PUSH_BIN) { $env:UNI_PUSH_BIN } else { Join-Path $(if ($env:UNI_PUSH_INSTALL_DIR) { $env:UNI_PUSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "UniPush\bin" }) "uni-push.exe" }
if (-not (Test-Path $binary)) { throw "uni-push is not installed" }
function Run-Safe([string]$Command) {
  $arguments = @($Command)
  if ($Config) { $arguments += @("--config", $Config) }
  $arguments += "--json"
  try { (& $binary @arguments 2>$null | Out-String).Trim() } catch { "" }
}
$version = (& $binary --version 2>$null | Out-String).Trim()
$sections = [ordered]@{ Version = $version; Doctor = (Run-Safe "doctor"); Targets = (Run-Safe "targets"); Channels = (Run-Safe "channels") }
$text = "# Uni Push issue report`n`n- Generated: ``$((Get-Date).ToUniversalTime().ToString("o"))```n- OS: ``Windows```n- Architecture: ``$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)```n`n"
foreach ($entry in $sections.GetEnumerator()) { $text += "## $($entry.Key)`n`n``````json`n$($entry.Value)`n```````n`n" }
$text += "> Review target and channel aliases before sharing. No issue was submitted automatically.`n"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $Output), $text, [System.Text.UTF8Encoding]::new($false))
Write-Output $Output
