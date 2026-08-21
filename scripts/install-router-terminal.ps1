[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [switch]$SkipDesktop,
  [string[]]$ShortcutDirectories,
  [ValidateSet('Com', 'Mock')]
  [string]$ShortcutBackend = 'Com',
  [string]$IconPath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$launcher = Join-Path $RepositoryRoot 'scripts\router-terminal.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }

if ($null -eq $ShortcutDirectories -or $ShortcutDirectories.Count -eq 0) {
  $ShortcutDirectories = @([Environment]::GetFolderPath('Programs'))
  if (-not $SkipDesktop) { $ShortcutDirectories += [Environment]::GetFolderPath('Desktop') }
}
$ShortcutDirectories = @($ShortcutDirectories | ForEach-Object { [IO.Path]::GetFullPath($_) })

if ([string]::IsNullOrWhiteSpace($IconPath)) {
  $IconPath = if ($ShortcutBackend -eq 'Com' -and $env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH)) {
    $env:CODEX_CLI_PATH
  } else {
    'powershell.exe'
  }
}

$entries = @(
  @{
    Name = 'Codex Router - Orchestrator'
    Mode = 'Orchestrator'
    Description = 'Open the deterministic Orchestrator planning and approval flow'
  }
)

$shell = if ($ShortcutBackend -eq 'Com' -and -not $DryRun) { New-Object -ComObject WScript.Shell } else { $null }

foreach ($directory in $ShortcutDirectories) {
  foreach ($entry in $entries) {
    $shortcutPath = Join-Path $directory "$($entry.Name).lnk"
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Mode $($entry.Mode)"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      if ($ShortcutBackend -eq 'Com') {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = 'powershell.exe'
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $RepositoryRoot
        $shortcut.IconLocation = "$IconPath,0"
        $shortcut.Description = $entry.Description
        $shortcut.Save()
      } else {
        $mockPath = "$shortcutPath.mock.json"
        [ordered]@{
          Name = $entry.Name
          TargetPath = 'powershell.exe'
          Arguments = $arguments
          WorkingDirectory = $RepositoryRoot
          IconLocation = "$IconPath,0"
          Description = $entry.Description
        } | ConvertTo-Json | Set-Content -LiteralPath $mockPath -Encoding utf8
      }
    }
    [pscustomobject]@{
      Name = $entry.Name
      Mode = $entry.Mode
      Path = $shortcutPath
      Backend = $ShortcutBackend
      DryRun = [bool]$DryRun
    }
  }
}
