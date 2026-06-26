@echo off
REM ============================================================
REM  Launch the OpenSandbox server as a HOST process (Docker runtime).
REM  ------------------------------------------------------------
REM  Installs-and-runs the server with uvx (no source, no manual pip,
REM  no k3s) on 0.0.0.0:30080 so the crewmeld container reaches it at
REM  http://host.docker.internal:30080:
REM
REM    uvx opensandbox-server@0.1.14 --config opensandbox-server.docker.toml
REM
REM  api_key is injected via OPENSANDBOX_SERVER_API_KEY, resolved from
REM  <deploy>\server-config.toml, repo-local .opensandbox-server-key, or
REM  generated+persisted there. miniStart uses the SAME resolver.
REM
REM  Runs in the FOREGROUND (it is a server). Ctrl+C to stop.
REM  Usage: serverStart.bat
REM ============================================================
setlocal EnableDelayedExpansion
pushd "%~dp0"

where uvx >NUL 2>&1 || ( echo uvx not found on PATH. Install uv: https://docs.astral.sh/uv/ & goto :err )

REM Already running? (curl ships with Windows 10+)
curl -fsS -o NUL --max-time 3 http://localhost:30080/health >NUL 2>&1
if not errorlevel 1 (
  echo [INFO] OpenSandbox server already responding on :30080 - nothing to do.
  goto :done
)

call :resolve_key
if "%API_KEY%"=="" ( echo Could not resolve api_key & goto :err )
set "OPENSANDBOX_SERVER_API_KEY=%API_KEY%"

echo [INFO] Starting OpenSandbox server (uvx, Docker runtime) on 0.0.0.0:30080...
echo        config: %CD%\opensandbox-server.docker.toml
echo        Ctrl+C to stop. crewmeld reaches it at http://host.docker.internal:30080
uvx opensandbox-server@0.1.14 --config "%CD%\opensandbox-server.docker.toml"
goto :done

REM ---- resolve_key -> sets API_KEY ----
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
if exist ".opensandbox-server-key" (
  set /p API_KEY=<.opensandbox-server-key
)
if not "%API_KEY%"=="" goto :eof
for /f %%H in ('powershell -NoProfile -Command "$b=New-Object byte[] 32;[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);($b|%%{$_.ToString('x2')}) -join ''"') do set "API_KEY=%%H"
>.opensandbox-server-key echo|set /p="%API_KEY%"
echo [INFO] Generated a new OpenSandbox api_key -^> .opensandbox-server-key
goto :eof

:err
popd
endlocal
exit /b 1

:done
popd
endlocal
exit /b 0
