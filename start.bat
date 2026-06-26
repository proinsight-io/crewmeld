@echo off
setlocal

rem Crewmeld one-click startup
rem Usage: start.bat [docker compose flags]
rem Examples:
rem   start.bat
rem   start.bat --profile opensandbox --profile minio
rem   start.bat --profile opensandbox --profile minio --profile ragflow --profile ollama

rem Ensure .env exists (only copy if missing)
if not exist .env (
    echo [INFO] Creating .env from .env.example...
    if not exist .env.example (
        echo ERROR: .env.example not found, cannot bootstrap .env
        exit /b 1
    )
    copy .env.example .env >nul
) else (
    echo [INFO] .env already exists, skipping copy.
)

rem Generate OPENSANDBOX_API_KEY at first deploy (host-side; NOT baked into the image).
powershell -NoProfile -Command "$p='.env'; $c=Get-Content $p -Raw; if($c -notmatch '(?m)^OPENSANDBOX_API_KEY=.+'){$r=[System.Security.Cryptography.RandomNumberGenerator]::Create();$b=New-Object byte[] 32;$r.GetBytes($b);$k=($b|ForEach-Object{$_.ToString('x2')}) -join '';if($c -match '(?m)^OPENSANDBOX_API_KEY='){Set-Content $p -Value ($c -replace '(?m)^OPENSANDBOX_API_KEY=.*',('OPENSANDBOX_API_KEY='+$k)) -NoNewline}else{Add-Content $p -Value ('OPENSANDBOX_API_KEY='+$k)};Write-Host '[INFO] Generated OPENSANDBOX_API_KEY (first deploy).'}"

rem Phase 1: Generate secrets (idempotent)
echo [INFO] Ensuring secrets (docker compose --profile init run --rm setup)...
docker compose --profile init run --rm setup
if errorlevel 1 (
    echo ERROR: Secret generation failed. Check: docker compose logs setup
    exit /b 1
)

rem Phase 2: Start all services with user-supplied profile flags
echo [INFO] Starting services (docker compose %* up -d)...
docker compose %* up -d
if errorlevel 1 (
    echo ERROR: Service startup failed. Check: docker compose logs
    exit /b 1
)

echo.
echo [OK] Crewmeld is starting at http://localhost:6100
echo      Logs: docker compose logs -f crewmeld
echo      Stop: docker compose down

endlocal
exit /b 0
