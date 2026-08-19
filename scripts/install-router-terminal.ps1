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

$entries = @(
  @{ Name = 'Codex Router Agent Terminal'; Mode = 'Menu'; Description = 'Choose Auto, DeepSeek Flash, DeepSeek Pro, or OpenAI Codex' },
  @{ Name = 'Codex Router - Auto'; Mode = 'Auto'; Description = 'Classify, plan, approve, and route automatically' },
  @{ Name = 'Codex Router - DeepSeek Flash'; Mode = 'Flash'; Description = 'Open native Codex with DeepSeek V4 Flash Responses API' },
  @{ Name = 'Codex Router - DeepSeek Pro'; Mode = 'Pro'; Description = 'Open native Codex with DeepSeek V4 Pro Responses API' },
  @{ Name = 'Codex Router - OpenAI'; Mode = 'OpenAI'; Description = 'Open native Codex with the normal OpenAI configuration' }
)

foreach ($directory in $shortcutDirectories) {
  foreach ($entry in $entries) {
    $shortcutPath = Join-Path $directory "$($entry.Name).lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Mode $($entry.Mode)"
    $shortcut.WorkingDirectory = $RepositoryRoot
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = $entry.Description
    $shortcut.Save()
    Write-Output $shortcutPath
  }
}
