<#
.SYNOPSIS
    Crewmeld one-click startup with the OpenSandbox k3s runtime (PowerShell).

.DESCRIPTION
    Brings the whole stack up in k3s mode end to end:
      1. ensure .env (copy from .env.example if missing) + generate secrets
      2. start the dedicated k3s node (compose service opensandbox-k3s) + db/redis
      3. wait for k3s to report Ready (kubeconfig at <deploy>/.kube/config)
      4. helm-install the OpenSandbox controller + server INTO that k3s, create the
         namespaces / batchsandbox ConfigMap, patch the service to NodePort 30080
      5. copy api_key from <deploy>/server-config.toml into crewmeld's .env and point
         OPENSANDBOX_SERVER_URL at the in-network NodePort (http://opensandbox-k3s:30080)
      6. start crewmeld (+ db/redis/migrations) with the updated .env
      7. verify the server /health from inside the crewmeld container

    All helm/kubectl paths are passed FORWARD-SLASHED on purpose: helm's --set-file
    parser eats Windows backslashes (D:\ai\... -> D:ai...), which is the documented
    bug in opensandbox-deploy/install-existing-windows.bat.

.PARAMETER Recreate
    Force-recreate containers so edited .env values take effect.

.EXAMPLE
    .\k3sStart.ps1
    .\k3sStart.ps1 -Recreate
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

# Forward-slash an absolute path so helm/kubectl don't mangle backslashes.
function To-Slash([string]$Path) { return ($Path -replace '\\', '/') }

# --- 0. Tooling check ---
foreach ($tool in 'docker', 'kubectl', 'helm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "Required tool not found on PATH: $tool"
        exit 1
    }
}

# --- 1. .env bootstrap + secrets ---
if (-not (Test-Path .env)) {
    Write-Host "[INFO] Creating .env from .env.example..."
    if (-not (Test-Path .env.example)) { Write-Error ".env.example not found"; exit 1 }
    Copy-Item .env.example .env
}
else {
    Write-Host "[INFO] .env already exists, skipping copy."
}

Write-Host "[INFO] Ensuring secrets (docker compose --profile init run --rm setup)..."
docker compose --profile init run --rm setup
if ($LASTEXITCODE -ne 0) { Write-Error "Secret generation failed. Check: docker compose logs setup"; exit 1 }

# --- Resolve the OpenSandbox deploy dir (holds charts / config / kubeconfig) ---
$deployRel = $env:OPENSANDBOX_DEPLOY_DIR
if (-not $deployRel) { $deployRel = Get-EnvValue 'OPENSANDBOX_DEPLOY_DIR' }
if (-not $deployRel) { $deployRel = '../opensandbox-deploy' }
$DeployDir = (Resolve-Path -Path $deployRel -ErrorAction SilentlyContinue)
if (-not $DeployDir) {
    Write-Error "OpenSandbox deploy dir not found: $deployRel (set OPENSANDBOX_DEPLOY_DIR)"
    exit 1
}
$DeployDir = $DeployDir.Path

$Kube   = Join-Path $DeployDir '.kube/config'
$Toml   = Join-Path $DeployDir 'server-config.toml'
$Values = Join-Path $DeployDir 'server-values.yaml'
$Batch  = Join-Path $DeployDir 'batchsandbox-template.yaml'
$ChartC = Join-Path $DeployDir 'charts/opensandbox-controller'
$ChartS = Join-Path $DeployDir 'charts/opensandbox-server'

foreach ($p in @($Toml, $Values, $Batch, $ChartC, $ChartS)) {
    if (-not (Test-Path $p)) { Write-Error "Missing deploy artifact: $p"; exit 1 }
}

# --- 2. Start the k3s node + core datastores ---
Write-Host "[INFO] Starting opensandbox-k3s + db + redis..."
$upArgs = @('--profile', 'opensandbox', 'up', '-d', 'opensandbox-k3s', 'db', 'redis')
if ($Recreate) { $upArgs += '--force-recreate' }
docker compose @upArgs
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to start opensandbox-k3s"; exit 1 }

# --- 3. Wait for k3s Ready (kubeconfig appears, node goes Ready) ---
Write-Host "[INFO] Waiting for k3s to become Ready (kubeconfig: $Kube)..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $Kube) {
        $nodes = & kubectl --kubeconfig $Kube get nodes --no-headers 2>$null
        if ($LASTEXITCODE -eq 0 -and ($nodes -match ' Ready')) { $ready = $true; break }
    }
    Start-Sleep -Seconds 5
    Write-Host "  ...still waiting ($(($i + 1) * 5)s)"
}
if (-not $ready) {
    Write-Error "k3s did not become Ready in time. Check: docker compose logs opensandbox-k3s"
    exit 1
}
Write-Host "[OK] k3s is Ready."

$KubeS   = To-Slash $Kube
$TomlS   = To-Slash $Toml
$ValuesS = To-Slash $Values
$BatchS  = To-Slash $Batch
$ChartCS = To-Slash $ChartC
$ChartSS = To-Slash $ChartS

# --- 4. Install OpenSandbox into the cluster ---
Write-Host "[INFO] [1/4] helm install opensandbox-controller..."
helm upgrade --install opensandbox-controller $ChartCS `
    --kubeconfig $KubeS `
    --namespace opensandbox-system --create-namespace `
    --set controller.snapshot.containerdSocketPath="" `
    --wait --timeout 5m
if ($LASTEXITCODE -ne 0) { Write-Error "controller install failed"; exit 1 }

Write-Host "[INFO] [2/4] ensure namespace opensandbox + batchsandbox ConfigMap..."
& kubectl --kubeconfig $KubeS get namespace opensandbox 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { kubectl --kubeconfig $KubeS create namespace opensandbox }
kubectl --kubeconfig $KubeS create configmap opensandbox-batchsandbox-template `
    -n opensandbox-system `
    --from-file=batchsandbox-template.yaml=$BatchS `
    --dry-run=client -o yaml | kubectl --kubeconfig $KubeS apply -f -
if ($LASTEXITCODE -ne 0) { Write-Error "batchsandbox ConfigMap apply failed"; exit 1 }

Write-Host "[INFO] [3/4] helm install opensandbox-server..."
helm upgrade --install opensandbox-server $ChartSS `
    --kubeconfig $KubeS `
    --namespace opensandbox-system `
    -f $ValuesS `
    --set-file configToml=$TomlS `
    --wait --timeout 5m
if ($LASTEXITCODE -ne 0) { Write-Error "server install failed"; exit 1 }

Write-Host "[INFO] [4/4] patch opensandbox-server svc to NodePort 30080..."
$patch = '{"spec":{"type":"NodePort","ports":[{"port":80,"targetPort":"http","nodePort":30080,"protocol":"TCP","name":"http"}]}}'
kubectl --kubeconfig $KubeS patch svc opensandbox-server -n opensandbox-system --type=merge -p $patch
if ($LASTEXITCODE -ne 0) { Write-Error "NodePort patch failed"; exit 1 }

# --- 5. Wire crewmeld's .env to the in-cluster server ---
$tomlRaw = Get-Content $Toml -Raw
if ($tomlRaw -notmatch 'api_key\s*=\s*"([^"]+)"') {
    Write-Error "Could not read api_key from $Toml"
    exit 1
}
$apiKey = $matches[1]
Set-EnvValue 'OPENSANDBOX_API_KEY'  $apiKey
Set-EnvValue 'OPENSANDBOX_SERVER_URL' 'http://opensandbox-k3s:30080'
Set-EnvValue 'OPENSANDBOX_USE_PROXY' '1'
Write-Host "[OK] Synced OPENSANDBOX_API_KEY + SERVER_URL (opensandbox-k3s:30080) into .env."

# --- 6. Start crewmeld with the updated .env ---
Write-Host "[INFO] Starting crewmeld (+ db/redis/migrations)..."
$crewArgs = @('up', '-d')
if ($Recreate) { $crewArgs += '--force-recreate' } else { $crewArgs += @('--force-recreate', 'crewmeld') }
docker compose @crewArgs
if ($LASTEXITCODE -ne 0) { Write-Error "crewmeld startup failed. Check: docker compose logs crewmeld"; exit 1 }

# --- 7. Verify ---
Write-Host "[INFO] Verifying server /health from inside the crewmeld container..."
Start-Sleep -Seconds 5
docker compose exec -T crewmeld sh -c "curl -fsS http://opensandbox-k3s:30080/health || wget -qO- http://opensandbox-k3s:30080/health" 2>$null
if ($LASTEXITCODE -eq 0) { Write-Host "[OK] OpenSandbox /health reachable from crewmeld." }
else { Write-Host "[WARN] Could not confirm /health (curl/wget may be absent in image); check manually." }

$appUrl = if ($env:NEXT_PUBLIC_APP_URL) { $env:NEXT_PUBLIC_APP_URL } else { 'http://localhost:6100' }
Write-Host ""
Write-Host "[OK] Crewmeld (k3s runtime) is starting at $appUrl"
Write-Host "     OpenSandbox server: http://opensandbox-k3s:30080 (in compose network)"
Write-Host "     Enable Dev Studio:  set DEV_STUDIO_ENABLED=1 in .env, then .\k3sStart.ps1 -Recreate"
Write-Host "     Logs: docker compose logs -f crewmeld"
Write-Host "     Stop: docker compose --profile opensandbox down"

exit 0
