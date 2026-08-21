[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('DeepSeekFlash', 'DeepSeekPro', 'OpenAI', 'Status')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
$codexDirectory = Join-Path $env:USERPROFILE '.codex'
$configPath = Join-Path $codexDirectory 'config.toml'
$routerDirectory = Join-Path $env:LOCALAPPDATA 'CodexRouter'
$stateDirectory = Join-Path $routerDirectory 'native-mode'
$backupPath = Join-Path $stateDirectory 'openai-config.toml'
$statePath = Join-Path $stateDirectory 'state.json'
$catalogPath = Join-Path $routerDirectory 'deepseek-models.json'
$authHelperPath = Join-Path $routerDirectory 'get-deepseek-token.ps1'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Get-FileHashValue {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextHashValue {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Content)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Content)) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha.Dispose()
  }
}

function Write-AtomicText {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
  $temporaryPath = "$Path.router-tmp"
  [IO.File]::WriteAllText($temporaryPath, $Content, $utf8NoBom)
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Read-State {
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  return [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
}

function Write-State {
  param([Parameter(Mandatory)][hashtable]$Value)
  Write-AtomicText -Path $statePath -Content (($Value | ConvertTo-Json -Depth 5) + "`n")
}

function Remove-ManagedDeepSeekConfig {
  param([Parameter(Mandatory)][string]$Content)
  $managedKeys = 'model|model_provider|preferred_auth_method|forced_login_method|model_reasoning_effort|model_reasoning_summary|model_catalog_json'
  $result = [Collections.Generic.List[string]]::new()
  $insideManagedProvider = $false
  $beforeFirstTable = $true
  foreach ($line in ($Content -split "`r?`n")) {
    if ($line -match '^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$') {
      $tableName = $Matches[1].Trim()
      $insideManagedProvider = $tableName -eq 'model_providers.deepseek' -or $tableName.StartsWith('model_providers.deepseek.')
      $beforeFirstTable = $false
      if ($insideManagedProvider) { continue }
    } elseif ($insideManagedProvider) {
      continue
    }
    if ($beforeFirstTable -and $line -match "^\s*(?:$managedKeys)\s*=") { continue }
    $result.Add($line)
  }
  return (($result -join "`n").Trim("`r", "`n"))
}

function New-DeepSeekConfig {
  param(
    [Parameter(Mandatory)][string]$OriginalConfig,
    [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][ValidateSet('low', 'high')][string]$Effort
  )
  $catalogTomlPath = $catalogPath.Replace('\', '/')
  $authTomlPath = $authHelperPath.Replace('\', '/')
  $preservedConfig = Remove-ManagedDeepSeekConfig -Content $OriginalConfig
  $header = @"
model = "$Model"
model_provider = "deepseek"
preferred_auth_method = "apikey"
forced_login_method = "api"
model_reasoning_effort = "$Effort"
model_reasoning_summary = "none"
model_catalog_json = "$catalogTomlPath"
"@
  $provider = @"
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
supports_websockets = false
request_max_retries = 2
stream_max_retries = 2

[model_providers.deepseek.auth]
command = "powershell.exe"
args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "$authTomlPath"]
timeout_ms = 5000
refresh_interval_ms = 0
"@
  return "$header`n`n$preservedConfig`n`n$provider`n"
}

function Assert-ManagedConfigUnchanged {
  param($State)
  if ($null -eq $State -or $State.active_mode -eq 'OpenAI') { return }
  $currentPreserved = Remove-ManagedDeepSeekConfig -Content ([IO.File]::ReadAllText($configPath))
  $originalPreserved = Remove-ManagedDeepSeekConfig -Content ([IO.File]::ReadAllText($backupPath))
  if ((Get-TextHashValue -Content $currentPreserved) -ne (Get-TextHashValue -Content $originalPreserved)) {
    throw 'Non-model Codex settings changed during native DeepSeek mode. Refusing to overwrite them; review ~/.codex/config.toml first.'
  }
}

New-Item -ItemType Directory -Path $codexDirectory, $stateDirectory -Force | Out-Null
$state = Read-State

if ($Mode -eq 'Status') {
  [pscustomobject]@{
    ActiveMode = if ($state) { $state.active_mode } else { 'OpenAI (unmanaged)' }
    Config = $configPath
    ConfigHash = Get-FileHashValue -Path $configPath
    OpenAIBackup = Test-Path -LiteralPath $backupPath
  }
  exit 0
}

if ($Mode -eq 'OpenAI') {
  if ($null -eq $state -or -not (Test-Path -LiteralPath $backupPath)) {
    throw 'No managed native-mode backup exists; the current OpenAI configuration was not changed.'
  }
  Assert-ManagedConfigUnchanged -State $state
  Write-AtomicText -Path $configPath -Content ([IO.File]::ReadAllText($backupPath))
  Write-State -Value @{
    active_mode = 'OpenAI'
    openai_config_sha256 = Get-FileHashValue -Path $configPath
    managed_config_sha256 = $null
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
  }
} else {
  foreach ($requiredPath in @($catalogPath, $authHelperPath, (Join-Path $routerDirectory 'deepseek-key.dpapi'))) {
    if (-not (Test-Path -LiteralPath $requiredPath)) { throw "DeepSeek prerequisite is missing: $requiredPath" }
  }
  if ($null -eq $state -or $state.active_mode -eq 'OpenAI') {
    $originalConfig = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { '' }
    Write-AtomicText -Path $backupPath -Content $originalConfig
  } else {
    Assert-ManagedConfigUnchanged -State $state
    $originalConfig = [IO.File]::ReadAllText($backupPath)
  }
  $model = if ($Mode -eq 'DeepSeekFlash') { 'deepseek-v4-flash' } else { 'deepseek-v4-pro' }
  $effort = if ($Mode -eq 'DeepSeekFlash') { 'low' } else { 'high' }
  Write-AtomicText -Path $configPath -Content (New-DeepSeekConfig -OriginalConfig $originalConfig -Model $model -Effort $effort)
  Write-State -Value @{
    active_mode = $Mode
    model = $model
    reasoning_effort = $effort
    openai_config_sha256 = Get-FileHashValue -Path $backupPath
    managed_config_sha256 = Get-FileHashValue -Path $configPath
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
  }
}

Write-Output "Codex native menu mode: $Mode"
Write-Output 'Close Codex normally and reopen it to apply the native provider menu.'
