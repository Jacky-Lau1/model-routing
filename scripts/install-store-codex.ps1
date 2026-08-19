[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\CodexStoreCLI')
)

$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage OpenAI.Codex
if (-not $package) { throw 'OpenAI.Codex Microsoft Store package is not installed.' }

$sourceDirectory = Join-Path $package.InstallLocation 'app\resources'
$programsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$targetDirectory = [IO.Path]::GetFullPath($InstallDirectory)
if (-not $targetDirectory.StartsWith($programsRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "InstallDirectory must remain under $programsRoot"
}

$assets = @(
  'codex.exe',
  'codex-code-mode-host.exe',
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe',
  'rg.exe',
  'codex-notification.wav'
)

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
foreach ($asset in $assets) {
  $source = Join-Path $sourceDirectory $asset
  if (-not (Test-Path -LiteralPath $source)) { throw "Store package asset missing: $source" }
  $target = Join-Path $targetDirectory $asset
  $copy = -not (Test-Path -LiteralPath $target)
  if (-not $copy) {
    $copy = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  }
  if ($copy) { Copy-Item -LiteralPath $source -Destination $target -Force }
}

$codexPath = Join-Path $targetDirectory 'codex.exe'
$manifest = [ordered]@{
  package_full_name = $package.PackageFullName
  source = (Join-Path $sourceDirectory 'codex.exe')
  installed_path = $codexPath
  sha256 = (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash
  installed_at = (Get-Date).ToUniversalTime().ToString('o')
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $targetDirectory 'store-source.json') -Encoding utf8
[Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $codexPath, 'User')

$routerHome = Join-Path $env:LOCALAPPDATA 'CodexRouter\codex-home'
New-Item -ItemType Directory -Path $routerHome -Force | Out-Null
$authSource = Join-Path $env:USERPROFILE '.codex\auth.json'
$authTarget = Join-Path $routerHome 'auth.json'
if (-not (Test-Path -LiteralPath $authSource)) { throw "Codex login file not found: $authSource" }
if (-not (Test-Path -LiteralPath $authTarget)) {
  New-Item -ItemType HardLink -Path $authTarget -Target $authSource | Out-Null
}
[Environment]::SetEnvironmentVariable('CODEX_ROUTER_HOME', $routerHome, 'User')

& $codexPath --version
$env:CODEX_HOME = $routerHome
& $codexPath login status
$manifest
