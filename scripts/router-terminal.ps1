[CmdletBinding()]
param(
  [string]$Project = (Get-Location).Path,
  [string]$RepositoryRoot,
  [ValidateSet('Menu', 'Auto', 'Flash', 'Pro', 'OpenAI')]
  [string]$Mode = 'Menu'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$Project = [IO.Path]::GetFullPath($Project)
$tsx = Join-Path $RepositoryRoot 'node_modules\.bin\tsx.cmd'
$runtimeDependencies = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$env:PATH = "$(Join-Path $runtimeDependencies 'node\bin');$(Join-Path $runtimeDependencies 'bin\fallback');$env:PATH"

if (-not (Test-Path -LiteralPath $tsx)) {
  throw "Router dependencies are missing. Run pnpm install in $RepositoryRoot first."
}

function Invoke-RouterCommand {
  param([string[]]$Arguments)
  $output = & $tsx (Join-Path $RepositoryRoot 'src\cli.ts') @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Router command failed with exit code $LASTEXITCODE." }
  return ($output | Out-String).Trim()
}

function Start-PlannedRoute {
  param([string[]]$Overrides)
  $objective = Read-Host 'Task objective'
  if ([string]::IsNullOrWhiteSpace($objective)) { return }
  $arguments = @('auto', $objective, '--project', $Project) + $Overrides
  $state = Invoke-RouterCommand -Arguments $arguments | ConvertFrom-Json
  Clear-Host
  Write-Host "Plan ready: $($state.taskId)" -ForegroundColor Cyan
  $state.plan | ConvertTo-Json -Depth 12
  $approve = $Host.UI.PromptForChoice('Approval boundary', 'Approve this exact plan and route?', @(
    [System.Management.Automation.Host.ChoiceDescription]::new('&Approve', 'Execute, validate, and review the frozen plan.'),
    [System.Management.Automation.Host.ChoiceDescription]::new('&Wait', 'Keep the checkpoint in WAITING_APPROVAL.'),
    [System.Management.Automation.Host.ChoiceDescription]::new('&Abort', 'Abort this task.')
  ), 1)
  if ($approve -eq 0) {
    Invoke-RouterCommand -Arguments @('approve', $state.taskId, '--project', $Project)
  } elseif ($approve -eq 2) {
    Invoke-RouterCommand -Arguments @('abort', $state.taskId)
  } else {
    Write-Host "Saved. Resume with: route approve $($state.taskId) --project `"$Project`""
  }
}

function Start-NativeCodex {
  param([string]$Profile)
  $codex = if ($env:CODEX_CLI_PATH) { $env:CODEX_CLI_PATH } else { Join-Path $env:LOCALAPPDATA 'Programs\CodexStoreCLI\codex.exe' }
  if (-not (Test-Path -LiteralPath $codex)) { throw 'Codex CLI is not installed. Run scripts/install-store-codex.ps1.' }
  if ($Profile) { & $codex --profile $Profile -C $Project } else { & $codex -C $Project }
}

if ($Mode -eq 'Auto') { Start-PlannedRoute -Overrides @(); return }
if ($Mode -eq 'Flash') { Start-NativeCodex -Profile 'deepseek-flash'; return }
if ($Mode -eq 'Pro') { Start-NativeCodex -Profile 'deepseek-pro'; return }
if ($Mode -eq 'OpenAI') { Start-NativeCodex -Profile ''; return }

do {
  Clear-Host
  Write-Host 'Codex Router Agent Terminal' -ForegroundColor Cyan
  Write-Host "Project: $Project"
  Write-Host 'Auto plans and requires approval; DeepSeek entries open native Codex Responses profiles.'
  $choice = $Host.UI.PromptForChoice('Route', 'Choose an entry:', @(
    [System.Management.Automation.Host.ChoiceDescription]::new('&Auto', 'Classify the task and choose Terra, Sol, DeepSeek Flash, or DeepSeek Pro.'),
    [System.Management.Automation.Host.ChoiceDescription]::new('DS &Flash', 'Open native Codex with the DeepSeek V4 Flash Responses profile.'),
    [System.Management.Automation.Host.ChoiceDescription]::new('DS &Pro', 'Open native Codex with the DeepSeek V4 Pro Responses profile.'),
    [System.Management.Automation.Host.ChoiceDescription]::new('&Codex', 'Open the native Codex terminal; use /model for OpenAI models.'),
    [System.Management.Automation.Host.ChoiceDescription]::new('&Quit', 'Close this launcher.')
  ), 0)
  switch ($choice) {
    0 { Start-PlannedRoute -Overrides @() }
    1 { Start-NativeCodex -Profile 'deepseek-flash' }
    2 { Start-NativeCodex -Profile 'deepseek-pro' }
    3 { Start-NativeCodex -Profile '' }
  }
  if ($choice -lt 3) { Read-Host 'Press Enter to return to the route menu' | Out-Null }
} while ($choice -ne 4)
