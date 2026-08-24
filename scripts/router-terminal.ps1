[CmdletBinding()]
param(
  [string]$DistributionRoot,
  [string]$NodeExecutable,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  @'
Codex Router compiled launcher (legacy interactive flow removed).
Provide -DistributionRoot and -NodeExecutable explicitly. This launcher opens only
the production CLI help; use canonical `route router ...` or offline dry-run commands.
'@
  return
}

if ([string]::IsNullOrWhiteSpace($DistributionRoot) -or [string]::IsNullOrWhiteSpace($NodeExecutable)) { throw 'DistributionRoot and NodeExecutable are required.' }
$DistributionRoot = [IO.Path]::GetFullPath($DistributionRoot)
$NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
$entrypoint = Join-Path $DistributionRoot 'dist\src\cli.js'
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf) -or -not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw 'Compiled Router launcher inputs are unavailable.' }

& $NodeExecutable $entrypoint '--help'
if ($LASTEXITCODE -ne 0) { throw "Compiled Router CLI failed with exit code $LASTEXITCODE." }
