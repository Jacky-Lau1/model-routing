[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [switch]$SkipDesktop
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$launcher = Join-Path $RepositoryRoot 'scripts\router-terminal.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }

$shell = New-Object -ComObject WScript.Shell
$shortcutDirectories = @([Environment]::GetFolderPath('Programs'))
if (-not $SkipDesktop) { $shortcutDirectories += [Environment]::GetFolderPath('Desktop') }
$icon = if ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH)) { $env:CODEX_CLI_PATH } else { 'powershell.exe' }

foreach ($directory in $shortcutDirectories) {
  $shortcutPath = Join-Path $directory 'Codex Router Agent Terminal.lnk'
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = 'powershell.exe'
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
  $shortcut.WorkingDirectory = $RepositoryRoot
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = 'Auto, DeepSeek Flash, DeepSeek Pro, and native Codex entry menu'
  $shortcut.Save()
  Write-Output $shortcutPath
}
