<#
.SYNOPSIS
    Launch the OpenSandbox server as a HOST process (PowerShell), Docker runtime.

.DESCRIPTION
    Installs-and-runs the server with uvx (no source checkout, no manual pip, no
    k3s) and serves it on 0.0.0.0:30080 so the crewmeld container can reach it at
    http://host.docker.internal:30080.

      uvx opensandbox-server@0.1.14 --config opensandbox-server.docker.toml

    The api_key is injected via OPENSANDBOX_SERVER_API_KEY, resolved from (in
    order) <deploy>/server-config.toml, a repo-local .opensandbox-server-key, or
    freshly generated and persisted to .opensandbox-server-key. miniStart uses
    the SAME resolver so crewmeld authenticates with the same key.

    This runs in the FOREGROUND (it is a server). Run it in its own terminal, or
    let miniStart launch it in the background. Stop with Ctrl+C.

.EXAMPLE
    .\serverStart.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Shared with miniStart: resolve the OpenSandbox api_key (single source of truth).
function Resolve-OpenSandboxApiKey {
    $deployRel = $env:OPENSANDBOX_DEPLOY_DIR
    if (-not $deployRel -and (Test-Path .env)) {
        foreach ($l in Get-Content .env) { if ($l -match '^\s*OPENSANDBOX_DEPLOY_DIR=(.+)$') { $deployRel = $matches[1].Trim() } }
    }
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
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://localhost:30080/health'
        return $r.StatusCode -eq 200
    }
    catch { return $false }
}

if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) {
    Write-Error "uvx not found on PATH. Install uv: https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
}

if (Test-ServerUp) {
    Write-Host "[INFO] OpenSandbox server already responding on :30080 — nothing to do."
    exit 0
}

$env:OPENSANDBOX_SERVER_API_KEY = Resolve-OpenSandboxApiKey
$config = Join-Path $PSScriptRoot 'opensandbox-server.docker.toml'
Write-Host "[INFO] Starting OpenSandbox server (uvx, Docker runtime) on 0.0.0.0:30080..."
Write-Host "       config: $config"
Write-Host "       Ctrl+C to stop. crewmeld reaches it at http://host.docker.internal:30080"
& uvx opensandbox-server@0.1.14 --config $config
exit $LASTEXITCODE
