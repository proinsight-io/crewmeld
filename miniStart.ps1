<#
.SYNOPSIS
    Crewmeld MINIMAL one-click (PowerShell): host OpenSandbox server + crewmeld +
    postgres + redis + MinIO — installed and running from a single command.

.DESCRIPTION
    Brings up the whole minimal stack:
      1. bootstrap .env + secrets + MinIO/OpenSandbox wiring
      2. resolve the shared OpenSandbox api_key (single source of truth)
      3. start the OpenSandbox server ON THE HOST in the background via uvx
         (no source, no manual pip, no k3s) — serverStart.ps1, Docker runtime,
         0.0.0.0:30080 — and wait until it is healthy
      4. bring up crewmeld + db + redis + MinIO (+ bucket) in compose

    crewmeld reaches the host server at http://host.docker.internal:30080 and
    MinIO at http://minio:9000 (in-network). The containerized OpenSandbox
    "docker" runtime is intentionally NOT used (its egress quirk 502s); a host
    process avoids that.

    Pass -Recreate to force-recreate containers so edited .env values take effect.
    To run the server in its OWN terminal instead, use .\serverStart.ps1.

.EXAMPLE
    .\miniStart.ps1
    .\miniStart.ps1 -Recreate
#>

[CmdletBinding()]
param(
    [switch]$Recreate
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path .env)) { return $null }
    foreach ($line in Get-Content .env) {
        if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") { return $matches[1].Trim() }
    }
    return $null
}

function Set-EnvValue([string]$Key, [string]$Value) {
    $raw = Get-Content .env -Raw
    if ($raw -match "(?m)^$([regex]::Escape($Key))=") {
        $raw = $raw -replace "(?m)^$([regex]::Escape($Key))=.*", "$Key=$Value"
    }
    else {
        if ($raw -and -not $raw.EndsWith("`n")) { $raw += "`n" }
        $raw += "$Key=$Value`n"
    }
    Set-Content .env -Value $raw -NoNewline
}

# Set a key only when it is currently absent or blank (don't clobber user edits).
function Set-EnvDefault([string]$Key, [string]$Value) {
    $cur = Get-EnvValue $Key
    if ([string]::IsNullOrWhiteSpace($cur)) { Set-EnvValue $Key $Value }
}

# Shared with serverStart.ps1: resolve the OpenSandbox api_key (single source of
# truth). Resolving here first persists a generated key so the server reads the
# same one.
function Resolve-OpenSandboxApiKey {
    $deployRel = $env:OPENSANDBOX_DEPLOY_DIR
    if (-not $deployRel) { $deployRel = Get-EnvValue 'OPENSANDBOX_DEPLOY_DIR' }
    if (-not $deployRel) { $deployRel = '../opensandbox-deploy' }
    $resolved = Resolve-Path -Path $deployRel -ErrorAction SilentlyContinue
    if ($resolved) {
        $toml = Join-Path $resolved.Path 'server-config.toml'
        if (Test-Path $toml) {
            $raw = Get-Content $toml -Raw
            if ($raw -match 'api_key\s*=\s*"([^"]+)"') { return $matches[1] }
        }
    }
    $local = Join-Path $PSScriptRoot '.opensandbox-server-key'
    if (Test-Path $local) {
        $k = (Get-Content $local -Raw).Trim()
        if ($k) { return $k }
    }
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] 32
    $rng.GetBytes($buf)
    $k = ($buf | ForEach-Object { $_.ToString('x2') }) -join ''
    Set-Content $local -Value $k -NoNewline
    Write-Host "[INFO] Generated a new OpenSandbox api_key -> .opensandbox-server-key"
    return $k
}

function Test-ServerUp {
    try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://localhost:30080/health').StatusCode -eq 200 }
    catch { return $false }
}

# --- 1. .env bootstrap ---
if (-not (Test-Path .env)) {
    Write-Host "[INFO] Creating .env from .env.example..."
    if (-not (Test-Path .env.example)) { Write-Error ".env.example not found"; exit 1 }
    Copy-Item .env.example .env
}
else {
    Write-Host "[INFO] .env already exists, skipping copy."
}

# --- 2. Auth secrets (idempotent) ---
Write-Host "[INFO] Ensuring secrets (docker compose --profile init run --rm setup)..."
docker compose --profile init run --rm setup
if ($LASTEXITCODE -ne 0) { Write-Error "Secret generation failed. Check: docker compose logs setup"; exit 1 }

# --- 3. Wire MinIO + OpenSandbox connection into .env ---
Set-EnvValue   'MINIO_ENDPOINT'          'http://minio:9000'
Set-EnvValue   'MINIO_EXTERNAL_ENDPOINT' 'http://host.docker.internal:9000'
Set-EnvDefault 'MINIO_ACCESS_KEY'        'rag_flow'
Set-EnvDefault 'MINIO_SECRET_KEY'        'infini_rag_flow'
Set-EnvDefault 'MINIO_BUCKET'            'tool-files'
Set-EnvValue   'OPENSANDBOX_SERVER_URL'  'http://host.docker.internal:30080'
# USE_PROXY=0: a host-run server on Docker Desktop cannot proxy to sandbox bridge
# IPs, so crewmeld connects DIRECTLY to each sandbox's published host port. The
# server returns those endpoints as host.docker.internal:<port> (see eip in
# opensandbox-server.docker.toml), which the crewmeld container can reach.
Set-EnvValue   'OPENSANDBOX_USE_PROXY'   '0'

# Resolve the api_key FIRST (persists a generated key) so crewmeld and the
# server use the same one, then write it for crewmeld.
$apiKey = Resolve-OpenSandboxApiKey
Set-EnvValue 'OPENSANDBOX_API_KEY' $apiKey
Write-Host "[OK] Wired MinIO (minio:9000) + OpenSandbox (host.docker.internal:30080) + api_key into .env."

# --- 4. Start the host OpenSandbox server (background) ---
if (Test-ServerUp) {
    Write-Host "[INFO] OpenSandbox server already up on :30080."
}
else {
    if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) {
        Write-Error "uvx not found; cannot start the OpenSandbox server. Install uv (https://docs.astral.sh/uv/) or run .\serverStart.ps1 yourself."
        exit 1
    }
    $log = Join-Path $PSScriptRoot 'opensandbox-server.log'
    Write-Host "[INFO] Launching OpenSandbox server in background (uvx) -> $log"
    Start-Process -FilePath 'powershell' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'serverStart.ps1') `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    for ($i = 0; $i -lt 90; $i++) { if (Test-ServerUp) { break }; Start-Sleep -Seconds 2 }
    if (-not (Test-ServerUp)) { Write-Error "OpenSandbox server did not become healthy; check $log"; exit 1 }
    Write-Host "[OK] OpenSandbox server healthy on :30080."
}

# --- 5. Bring up the minimal stack (core + MinIO profile) ---
Write-Host "[INFO] Starting minimal stack (crewmeld + pg + redis + MinIO)..."
$upArgs = @('--profile', 'minio', 'up', '-d')
if ($Recreate) { $upArgs += '--force-recreate' }
docker compose @upArgs
if ($LASTEXITCODE -ne 0) { Write-Error "Service startup failed. Check: docker compose logs"; exit 1 }

# --- 6. Notes ---
$appUrl = if ($env:NEXT_PUBLIC_APP_URL) { $env:NEXT_PUBLIC_APP_URL } else { 'http://localhost:6100' }
Write-Host ""
Write-Host "[OK] Crewmeld minimal stack is starting at $appUrl"
Write-Host "     MinIO:       http://minio:9000 (in-network)  /  console http://localhost:9001"
Write-Host "     OpenSandbox: host process on :30080 (logs: opensandbox-server.log)"
Write-Host "                  stop it with:  Get-Process | ? { `$_.Path -like '*uv*' } | Stop-Process   (or close its window)"
Write-Host "     Logs: docker compose logs -f crewmeld"
Write-Host "     Stop: docker compose --profile minio down   (then stop the host server)"

exit 0
