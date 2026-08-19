[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:LOCALAPPDATA 'CodexRouter'
$target = Join-Path $directory 'deepseek-key.dpapi'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$secret = Read-Host 'DeepSeek API Key (input is hidden)' -AsSecureString
if ($secret.Length -eq 0) { throw 'API Key cannot be empty.' }
$encrypted = ConvertFrom-SecureString $secret
Set-Content -LiteralPath $target -Value $encrypted -Encoding ascii
Write-Output "DeepSeek API Key encrypted with DPAPI for the current Windows user: $target"
