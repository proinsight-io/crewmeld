@echo off
setlocal

rem Crewmeld DESTRUCTIVE reset    removes containers, volumes, and local artifacts.
rem Usage: reset.bat [--yes] [docker compose flags]
rem Examples:
rem   reset.bat                                          (interactive, default profiles)
rem   reset.bat --yes                                    (skip confirmation)
rem   reset.bat --yes --profile opensandbox --profile minio --profile ragflow --profile ollama

rem Parse --yes flag (must be first arg if present)
set "AUTO_YES=0"
set "COMPOSE_ARGS=%*"
if /I "%~1"=="--yes" (
    set "AUTO_YES=1"
    set "COMPOSE_ARGS=%COMPOSE_ARGS:--yes=%"
)
if /I "%~1"=="-y" (
    set "AUTO_YES=1"
    set "COMPOSE_ARGS=%COMPOSE_ARGS:-y=%"
)

echo.
echo ============================================================
echo  WARNING: This will permanently delete all Crewmeld data:
echo    - all containers in this compose project
echo    - all named volumes (postgres / redis / minio / opensandbox / ragflow / ollama)
echo    - local .env (regenerated on next start)
echo    - local autogen state (./shared,  ./temp)
echo ============================================================
echo.

if "%AUTO_YES%"=="0" (
    set /p CONFIRM="Type 'yes' to continue: "
    if /I not "%CONFIRM%"=="yes" (
        echo [INFO] Aborted.
        exit /b 1
    )
)

rem Phase 1: Stop and remove containers + volumes (all profiles)
echo [INFO] Stopping containers and removing volumes...
docker compose %COMPOSE_ARGS% --profile init --profile opensandbox --profile minio --profile ragflow --profile ollama --profile ollama-cpu --profile ollama-setup down -v --remove-orphans

rem Phase 2: Remove any orphan named volumes that survived (defensive)
echo [INFO] Pruning leftover crewmeld volumes...
for /f "tokens=*" %%v in ('docker volume ls -q --filter "name=crewmeld_"') do (
    echo   - removing %%v
    docker volume rm %%v >nul 2>&1
)

rem Phase 3: Remove local generated files
echo [INFO] Removing local artifacts...
if exist .env (
    del /q .env
    echo   - .env
)
if exist autogen.env (
    del /q autogen.env
    echo   - autogen.env
)
if exist shared\autogen.env (
    del /q shared\autogen.env
    echo   - shared\autogen.env
)
if exist temp (
    rmdir /s /q temp
    echo   - temp\
)

echo.
echo [OK] Reset complete. Run start.bat to bootstrap a fresh environment.

endlocal
exit /b 0
