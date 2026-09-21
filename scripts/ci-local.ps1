param(
  [switch]$Install
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepositoryRoot

Write-Host "LLMatic Agent Runtime - Windows Local CI"

if ($Install) {
  Write-Host ""
  Write-Host "=== Dependency installation ==="
  corepack pnpm install --no-frozen-lockfile

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

corepack pnpm ci:local
exit $LASTEXITCODE
