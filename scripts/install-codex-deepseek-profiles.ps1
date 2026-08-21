[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$officialScriptUrl = 'https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.ps1'
$officialScriptSha256 = '239c5e7e4a24a5216cf03756cc66d7459c748a46d1d4bf084418d2b58ef54a36'
$credentialPath = Join-Path $env:LOCALAPPDATA 'CodexRouter\deepseek-key.dpapi'
$routerDirectory = Join-Path $env:LOCALAPPDATA 'CodexRouter'
$codexDirectory = Join-Path $env:USERPROFILE '.codex'
$catalogPath = Join-Path $routerDirectory 'deepseek-models.json'
$authHelperPath = Join-Path $routerDirectory 'get-deepseek-token.ps1'
$backupDirectory = Join-Path $routerDirectory 'profile-backups'

if (-not (Test-Path -LiteralPath $credentialPath)) {
  throw 'DeepSeek DPAPI credential is missing. Run scripts/set-deepseek-key.ps1 first.'
}

$response = Invoke-WebRequest -UseBasicParsing -Uri $officialScriptUrl
$bytes = [byte[]]$response.Content
$sha = [Security.Cryptography.SHA256]::Create()
$actualHash = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
if ($actualHash -ne $officialScriptSha256) {
  throw "DeepSeek official setup script hash changed. Expected $officialScriptSha256, received $actualHash. Review before updating."
}
$officialScript = [Text.Encoding]::UTF8.GetString($bytes)
$catalogMatch = [regex]::Match($officialScript, '(?s)\$ModelsJson\s*=\s*@''\r?\n(.*?)\r?\n''@')
if (-not $catalogMatch.Success) { throw 'Could not extract the official DeepSeek models.json catalog.' }
$catalogJson = $catalogMatch.Groups[1].Value
$parsedCatalog = $catalogJson | ConvertFrom-Json
$slugs = @($parsedCatalog.models | ForEach-Object { $_.slug })
if ($slugs -notcontains 'deepseek-v4-flash' -or $slugs -notcontains 'deepseek-v4-pro') {
  throw 'Official model catalog does not contain both DeepSeek V4 models.'
}

New-Item -ItemType Directory -Path $routerDirectory, $codexDirectory, $backupDirectory -Force | Out-Null
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Save-RouterFile {
  param([string]$Path, [string]$Content)
  if (Test-Path -LiteralPath $Path) {
    $existing = [IO.File]::ReadAllText($Path)
    if ($existing -ne $Content) {
      $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
      Copy-Item -LiteralPath $Path -Destination (Join-Path $backupDirectory "$([IO.Path]::GetFileName($Path)).$stamp.bak")
    }
  }
  $temporaryPath = "$Path.router-tmp"
  [IO.File]::WriteAllText($temporaryPath, $Content, $utf8NoBom)
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

$authHelper = @'
$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path $env:LOCALAPPDATA 'CodexRouter\deepseek-key.dpapi'
$encrypted = [IO.File]::ReadAllText($credentialPath).Trim()
$secure = ConvertTo-SecureString $encrypted
$credential = [pscredential]::new('deepseek', $secure)
[Console]::Out.Write($credential.GetNetworkCredential().Password)
'@
Save-RouterFile -Path $catalogPath -Content ($catalogJson + "`n")
Save-RouterFile -Path $authHelperPath -Content ($authHelper + "`n")

$catalogTomlPath = $catalogPath.Replace('\', '/')
$authTomlPath = $authHelperPath.Replace('\', '/')
function New-ProfileContent {
  param([string]$Model, [string]$Effort)
  return @"
model = "$Model"
model_provider = "deepseek"
model_reasoning_effort = "$Effort"
model_reasoning_summary = "none"
model_catalog_json = "$catalogTomlPath"

[history]
persistence = "none"

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
}

$flashProfile = Join-Path $codexDirectory 'deepseek-flash.config.toml'
$proProfile = Join-Path $codexDirectory 'deepseek-pro.config.toml'
Save-RouterFile -Path $flashProfile -Content (New-ProfileContent -Model 'deepseek-v4-flash' -Effort 'low')
Save-RouterFile -Path $proProfile -Content (New-ProfileContent -Model 'deepseek-v4-pro' -Effort 'high')

[pscustomobject]@{
  Profiles = @('deepseek-flash', 'deepseek-pro')
  Catalog = $catalogPath
  Auth = 'Windows DPAPI command-backed bearer token'
  PlaintextKeyWritten = $false
}
