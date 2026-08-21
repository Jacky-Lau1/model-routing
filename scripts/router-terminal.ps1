[CmdletBinding()]
param(
  [string]$Project = (Get-Location).Path,
  [string]$RepositoryRoot,
  [ValidateSet('Orchestrator')]
  [string]$Mode = 'Orchestrator',
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  @'
Codex Router Terminal

Normal path:
  Orchestrator  Prepare a task with the deterministic Router, then stop for approval.

This launcher only exposes the Orchestrator. Use the explicit route live-benchmark
command only when a user separately authorizes a real API benchmark.
'@
  return
}

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

function Start-Orchestrator {
  $objective = Read-Host 'Task objective'
  if ([string]::IsNullOrWhiteSpace($objective)) { return }
  $arguments = @('auto', $objective, '--project', $Project)
  $state = Invoke-RouterCommand -Arguments $arguments | ConvertFrom-Json
  Clear-Host
  Write-Host "Orchestrator plan ready: $($state.taskId)" -ForegroundColor Cyan
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

Start-Orchestrator
