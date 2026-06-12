<#
.SYNOPSIS
    Crewmeld one-click startup (PowerShell).

.DESCRIPTION
    Two-phase startup:
      1. Generate secrets idempotently via `docker compose --profile init run --rm setup`
      2. Start all services with user-supplied docker compose flags (typically --profile ...)

    If `.env` does not exist, copies `.env.example` to `.env` first. If `.env`
    already exists, leaves it untouched.

.EXAMPLE
    .\start.ps1
    .\start.ps1 --profile opensandbox --profile minio
    .\start.ps1 --profile opensandbox --profile minio --profile ragflow --profile ollama
#>

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs = @()
)

$ErrorActionPreference = 'Stop'

# Ensure .env exists (only copy if missing)
if (-not (Test-Path .env)) {
    Write-Host "[INFO] Creating .env from .env.example..."
    if (-not (Test-Path .env.example)) {
        Write-Error ".env.example not found, cannot bootstrap .env"
        exit 1
    }
    Copy-Item .env.example .env
}
else {
    Write-Host "[INFO] .env already exists, skipping copy."
}

# Generate OPENSANDBOX_API_KEY at first deploy (host-side; NOT baked into the
# image). Shared by crewmeld and the docker-runtime OpenSandbox server.
$envRaw = Get-Content .env -Raw
if ($envRaw -notmatch '(?m)^OPENSANDBOX_API_KEY=.+') {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] 32
    $rng.GetBytes($buf)
    $osKey = ($buf | ForEach-Object { $_.ToString('x2') }) -join ''
    if ($envRaw -match '(?m)^OPENSANDBOX_API_KEY=') {
        $envRaw = $envRaw -replace '(?m)^OPENSANDBOX_API_KEY=.*', "OPENSANDBOX_API_KEY=$osKey"
        Set-Content .env -Value $envRaw -NoNewline
    }
    else {
        Add-Content .env -Value "OPENSANDBOX_API_KEY=$osKey"
    }
    Write-Host "[INFO] Generated OPENSANDBOX_API_KEY (first deploy)."
}

# Phase 1: Generate secrets (idempotent)
Write-Host "[INFO] Ensuring secrets (docker compose --profile init run --rm setup)..."
docker compose --profile init run --rm setup
if ($LASTEXITCODE -ne 0) {
    Write-Error "Secret generation failed. Check: docker compose logs setup"
    exit 1
}

# Phase 2: Start all services with user-supplied flags
$argsDisplay = if ($ComposeArgs.Count -gt 0) { $ComposeArgs -join ' ' } else { '(none)' }
Write-Host "[INFO] Starting services (docker compose $argsDisplay up -d)..."
docker compose @ComposeArgs up -d
if ($LASTEXITCODE -ne 0) {
    Write-Error "Service startup failed. Check: docker compose logs"
    exit 1
}

$appUrl = if ($env:NEXT_PUBLIC_APP_URL) { $env:NEXT_PUBLIC_APP_URL } else { 'http://localhost:6100' }
Write-Host ""
Write-Host "[OK] Crewmeld is starting at $appUrl"
Write-Host "     Logs: docker compose logs -f crewmeld"
Write-Host "     Stop: docker compose down"

exit 0
