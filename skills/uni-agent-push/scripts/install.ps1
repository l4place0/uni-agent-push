[CmdletBinding()]
param(
  [string]$Version = $(if ($env:UNI_PUSH_VERSION) { $env:UNI_PUSH_VERSION } else { "latest" }),
  [string]$InstallDir = $(if ($env:UNI_PUSH_INSTALL_DIR) { $env:UNI_PUSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "UniPush\bin" })
)
$ErrorActionPreference = "Stop"
$repository = if ($env:UNI_PUSH_REPOSITORY) { $env:UNI_PUSH_REPOSITORY } else { "l4place0/uni-agent-push" }
$architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  "X64" { "x64" }
  "Arm64" { "arm64" }
  default { throw "Unsupported CPU architecture" }
}
$archive = "uni-push-windows-$architecture.zip"
$base = if ($Version -eq "latest") {
  "https://github.com/$repository/releases/latest/download"
} else {
  $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  "https://github.com/$repository/releases/download/$tag"
}
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("uni-push-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  Invoke-WebRequest "$base/$archive" -OutFile (Join-Path $temporary $archive)
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $temporary "SHA256SUMS")
  $line = Get-Content (Join-Path $temporary "SHA256SUMS") | Where-Object { $_ -match ("\s" + [regex]::Escape($archive) + "$") }
  if (-not $line) { throw "Release checksum is missing" }
  $expected = ($line -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash (Join-Path $temporary $archive) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "Release checksum mismatch" }
  Expand-Archive (Join-Path $temporary $archive) -DestinationPath $temporary
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $pending = Join-Path $InstallDir ".uni-push.new.exe"
  $destination = Join-Path $InstallDir "uni-push.exe"
  Copy-Item (Join-Path $temporary "uni-push.exe") $pending -Force
  Move-Item $pending $destination -Force
  & $destination --version
  Write-Output "Installed $destination"
} finally {
  Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
