<#
.SYNOPSIS
    Crewmeld DESTRUCTIVE reset — removes containers, volumes, and local artifacts.

.DESCRIPTION
    Three-phase teardown:
      1. `docker compose down -v` across every profile (containers + named volumes)
      2. Defensive prune of any leftover crewmeld_* volumes
      3. Delete local generated files (.env, autogen.env, temp/)

    Use -Yes to skip the interactive confirmation prompt.

.EXAMPLE
    .\reset.ps1
    .\reset.ps1 -Yes
    .\reset.ps1 -Yes --profile opensandbox --profile minio --profile ragflow --profile ollama
#>

[CmdletBinding()]
param(
    [switch]$Yes,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs = @()
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host " WARNING: This will permanently delete all Crewmeld data:" -ForegroundColor Yellow
Write-Host "   - all containers in this compose project" -ForegroundColor Yellow
Write-Host "   - all named volumes (postgres / redis / minio / opensandbox / ragflow / ollama)" -ForegroundColor Yellow
Write-Host "   - local .env (regenerated on next start)" -ForegroundColor Yellow
Write-Host "   - local autogen state (./shared, ./temp)" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""

if (-not $Yes) {
    $confirm = Read-Host "Type 'yes' to continue"
    if ($confirm -ne 'yes') {
        Write-Host "[INFO] Aborted."
        exit 1
    }
}

# Phase 1: Down with all profiles + volumes
Write-Host "[INFO] Stopping containers and removing volumes..."
$allProfiles = @(
    '--profile', 'init',
    '--profile', 'opensandbox',
    '--profile', 'minio',
    '--profile', 'ragflow',
    '--profile', 'ollama',
    '--profile', 'ollama-cpu',
    '--profile', 'ollama-setup'
)
docker compose @ComposeArgs @allProfiles down -v --remove-orphans
# Ignore non-zero exit on down — best-effort teardown

# Phase 2: Prune leftover named volumes
Write-Host "[INFO] Pruning leftover crewmeld volumes..."
$leftover = docker volume ls -q --filter "name=crewmeld_" 2>$null
if ($leftover) {
    foreach ($vol in $leftover) {
        if ($vol) {
            Write-Host "   - removing $vol"
            docker volume rm $vol 2>$null | Out-Null
        }
    }
}

# Phase 3: Local artifacts
Write-Host "[INFO] Removing local artifacts..."
$artifacts = @(
    '.env',
    'autogen.env',
    'shared/autogen.env',
    'temp'
)
foreach ($path in $artifacts) {
    if (Test-Path $path) {
        Remove-Item -Path $path -Recurse -Force
        Write-Host "   - $path"
    }
}

Write-Host ""
Write-Host "[OK] Reset complete. Run .\start.ps1 to bootstrap a fresh environment." -ForegroundColor Green
exit 0
