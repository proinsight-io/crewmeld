@echo off
setlocal EnableDelayedExpansion
pushd "%~dp0"

rem Crewmeld MINIMAL one-click: host OpenSandbox server + crewmeld + postgres +
rem redis + MinIO - installed and running from a single command.
rem
rem   1. bootstrap .env + secrets + MinIO/OpenSandbox wiring
rem   2. resolve the shared OpenSandbox api_key (single source of truth)
rem   3. start the OpenSandbox server ON THE HOST in the background via uvx
rem      (no source, no manual pip, no k3s) -> serverStart.bat, Docker runtime,
rem      0.0.0.0:30080 -> wait until healthy
rem   4. bring up crewmeld + db + redis + MinIO (+ bucket) in compose
rem
rem crewmeld reaches the host server at http://host.docker.internal:30080 and
rem MinIO at http://minio:9000. The containerized OpenSandbox docker runtime is
rem intentionally NOT used (egress quirk 502s); a host process avoids that. To
rem run the server in its own terminal instead, use serverStart.bat.
rem
rem Usage: miniStart.bat [--recreate]

set "RECREATE="
if /I "%~1"=="--recreate" set "RECREATE=--force-recreate"

rem --- 1. .env bootstrap ---
if not exist .env (
    echo [INFO] Creating .env from .env.example...
    if not exist .env.example ( echo ERROR: .env.example not found & goto :err )
    copy .env.example .env >nul
) else (
    echo [INFO] .env already exists, skipping copy.
)

rem --- 2. auth secrets ---
echo [INFO] Ensuring secrets (docker compose --profile init run --rm setup)...
docker compose --profile init run --rm setup
if errorlevel 1 ( echo ERROR: Secret generation failed. & goto :err )

rem --- 3. wire MinIO + OpenSandbox into .env ---
call :setenv MINIO_ENDPOINT          "http://minio:9000"
call :setenv MINIO_EXTERNAL_ENDPOINT "http://host.docker.internal:9000"
call :setdef MINIO_ACCESS_KEY        "rag_flow"
call :setdef MINIO_SECRET_KEY        "infini_rag_flow"
call :setdef MINIO_BUCKET            "tool-files"
call :setenv OPENSANDBOX_SERVER_URL  "http://host.docker.internal:30080"
rem USE_PROXY=0: host-run server on Docker Desktop can't proxy to sandbox bridge
rem IPs; crewmeld connects directly to each sandbox's published host port (server
rem returns host.docker.internal:<port> via eip in opensandbox-server.docker.toml).
call :setenv OPENSANDBOX_USE_PROXY   "0"
call :resolve_key
if "%API_KEY%"=="" ( echo ERROR: could not resolve api_key & goto :err )
call :setenv OPENSANDBOX_API_KEY "%API_KEY%"
echo [OK] Wired MinIO (minio:9000) + OpenSandbox (host.docker.internal:30080) + api_key into .env.

rem --- 4. start the host OpenSandbox server (background) ---
curl -fsS -o NUL --max-time 3 http://localhost:30080/health >NUL 2>&1
if not errorlevel 1 (
  echo [INFO] OpenSandbox server already up on :30080.
) else (
  where uvx >NUL 2>&1 || ( echo ERROR: uvx not found; install uv or run serverStart.bat yourself. & goto :err )
  echo [INFO] Launching OpenSandbox server in background; logs in opensandbox-server.log
  start "opensandbox-server" /min cmd /c "serverStart.bat > opensandbox-server.log 2>&1"
  set "READY="
  for /l %%i in (1,1,90) do (
    if not defined READY (
      curl -fsS -o NUL --max-time 3 http://localhost:30080/health >NUL 2>&1
      if not errorlevel 1 ( set "READY=1" ) else ( timeout /t 2 /nobreak >NUL )
    )
  )
  if not defined READY ( echo ERROR: OpenSandbox server did not become healthy; check opensandbox-server.log & goto :err )
  echo [OK] OpenSandbox server healthy on :30080.
)

rem --- 5. bring up the minimal stack (core + MinIO) ---
echo [INFO] Starting minimal stack (crewmeld + pg + redis + MinIO)...
docker compose --profile minio up -d %RECREATE%
if errorlevel 1 ( echo ERROR: Service startup failed. Check: docker compose logs & goto :err )

echo.
echo [OK] Crewmeld minimal stack is starting at http://localhost:6100
echo      MinIO:       http://minio:9000 (in-network)  /  console http://localhost:9001
echo      OpenSandbox: host process on :30080 (logs: opensandbox-server.log)
echo      Logs: docker compose logs -f crewmeld
echo      Stop: docker compose --profile minio down   (then stop the host server window)
popd
endlocal
exit /b 0

rem ---- setenv KEY VALUE : replace-or-append in .env ----
:setenv
set "K=%~1"
set "V=%~2"
powershell -NoProfile -Command "$p='.env'; $k='%K%'; $v='%V%'; $r=Get-Content $p -Raw; if($r -match ('(?m)^'+[regex]::Escape($k)+'=')){$r=$r -replace ('(?m)^'+[regex]::Escape($k)+'=.*'),($k+'='+$v)}else{if($r -and -not $r.EndsWith(\"`n\")){$r+=\"`n\"};$r+=$k+'='+$v+\"`n\"};Set-Content $p -Value $r -NoNewline"
goto :eof

rem ---- setdef KEY VALUE : set only when absent or blank ----
:setdef
set "K=%~1"
set "V=%~2"
set "CUR="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "%K%=" .env 2^>nul`) do set "CUR=%%B"
if defined CUR ( set "CUR=" & goto :eof )
call :setenv "%K%" "%V%"
goto :eof

rem ---- resolve_key -> sets API_KEY (shared with serverStart) ----
:resolve_key
set "API_KEY="
set "DEPLOY_REL=%OPENSANDBOX_DEPLOY_DIR%"
if "%DEPLOY_REL%"=="" if exist .env (
  for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "OPENSANDBOX_DEPLOY_DIR=" .env`) do set "DEPLOY_REL=%%B"
)
if "%DEPLOY_REL%"=="" set "DEPLOY_REL=..\opensandbox-deploy"
for %%I in ("%DEPLOY_REL%") do set "DEPLOY_DIR=%%~fI"
set "SERVER_TOML=%DEPLOY_DIR%\server-config.toml"
if exist "%SERVER_TOML%" (
  for /f "usebackq tokens=2 delims==" %%K in (`findstr /b "api_key" "%SERVER_TOML%"`) do (
    set "RAW=%%K"
    set "RAW=!RAW: =!"
    set "RAW=!RAW:"=!"
    set "API_KEY=!RAW!"
  )
)
if not "%API_KEY%"=="" goto :eof
if exist ".opensandbox-server-key" set /p API_KEY=<.opensandbox-server-key
if not "%API_KEY%"=="" goto :eof
for /f %%H in ('powershell -NoProfile -Command "$b=New-Object byte[] 32;[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);($b|%%{$_.ToString('x2')}) -join ''"') do set "API_KEY=%%H"
>.opensandbox-server-key echo|set /p="%API_KEY%"
echo [INFO] Generated a new OpenSandbox api_key -^> .opensandbox-server-key
goto :eof

:err
echo.
echo  ^>^>^> miniStart FAILED. See messages above. ^<^<^<
popd
endlocal
exit /b 1
