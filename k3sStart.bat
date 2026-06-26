@echo off
REM ============================================================
REM  Crewmeld one-click startup - OpenSandbox k3s runtime (cmd)
REM  ------------------------------------------------------------
REM  .env + secrets -> start k3s node + db/redis -> wait Ready ->
REM  helm-install controller + server into k3s, namespaces /
REM  batchsandbox ConfigMap, patch NodePort 30080 -> sync api_key
REM  from <deploy>\server-config.toml into .env (SERVER_URL ->
REM  opensandbox-k3s:30080) -> start crewmeld -> verify /health.
REM
REM  helm/kubectl get FORWARD-SLASH paths on purpose: helm's
REM  --set-file parser eats Windows backslashes (D:\ai -> D:ai).
REM
REM  Usage:  k3sStart.bat  [--recreate]
REM ============================================================
setlocal EnableDelayedExpansion
pushd "%~dp0"

set "RECREATE="
if /i "%~1"=="--recreate" set "RECREATE=--force-recreate"

REM --- 0. tooling ---
for %%T in (docker kubectl helm) do (
  where %%T >NUL 2>&1 || ( echo Required tool not found on PATH: %%T & goto :err )
)

REM --- 1. .env + secrets ---
if not exist .env (
  echo [INFO] Creating .env from .env.example...
  if not exist .env.example ( echo .env.example not found & goto :err )
  copy /y .env.example .env >NUL
) else (
  echo [INFO] .env already exists, skipping copy.
)

echo [INFO] Ensuring secrets ^(docker compose --profile init run --rm setup^)...
docker compose --profile init run --rm setup
if errorlevel 1 ( echo Secret generation failed. & goto :err )

REM --- resolve deploy dir ---
set "DEPLOY_REL=%OPENSANDBOX_DEPLOY_DIR%"
if "%DEPLOY_REL%"=="" (
  for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "OPENSANDBOX_DEPLOY_DIR=" .env`) do set "DEPLOY_REL=%%B"
)
if "%DEPLOY_REL%"=="" set "DEPLOY_REL=..\opensandbox-deploy"
for %%I in ("%DEPLOY_REL%") do set "DEPLOY_DIR=%%~fI"
if not exist "%DEPLOY_DIR%" ( echo Deploy dir not found: %DEPLOY_REL% & goto :err )

set "KUBE=%DEPLOY_DIR%\.kube\config"
set "TOML=%DEPLOY_DIR%\server-config.toml"
set "VALUES=%DEPLOY_DIR%\server-values.yaml"
set "BATCH=%DEPLOY_DIR%\batchsandbox-template.yaml"
set "CHART_C=%DEPLOY_DIR%\charts\opensandbox-controller"
set "CHART_S=%DEPLOY_DIR%\charts\opensandbox-server"
for %%P in ("%TOML%" "%VALUES%" "%BATCH%" "%CHART_C%" "%CHART_S%") do (
  if not exist "%%~P" ( echo Missing deploy artifact: %%~P & goto :err )
)

REM Forward-slashed copies for helm/kubectl args.
set "KUBE_S=%KUBE:\=/%"
set "TOML_S=%TOML:\=/%"
set "VALUES_S=%VALUES:\=/%"
set "BATCH_S=%BATCH:\=/%"
set "CHART_C_S=%CHART_C:\=/%"
set "CHART_S_S=%CHART_S:\=/%"

REM --- 2. start k3s + core ---
echo [INFO] Starting opensandbox-k3s + db + redis...
docker compose --profile opensandbox up -d %RECREATE% opensandbox-k3s db redis
if errorlevel 1 ( echo Failed to start opensandbox-k3s & goto :err )

REM --- 3. wait Ready ---
echo [INFO] Waiting for k3s to become Ready ^(kubeconfig: %KUBE%^)...
set "READY="
for /l %%i in (1,1,60) do (
  if not defined READY (
    if exist "%KUBE%" (
      kubectl --kubeconfig "%KUBE_S%" get nodes --no-headers 2>NUL | findstr /c:" Ready" >NUL && set "READY=1"
    )
    if not defined READY (
      set /a "S=%%i*5"
      echo   ...still waiting !S!s
      timeout /t 5 /nobreak >NUL
    )
  )
)
if not defined READY ( echo k3s did not become Ready. Check: docker compose logs opensandbox-k3s & goto :err )
echo [OK] k3s is Ready.

REM --- 4. install OpenSandbox ---
echo [INFO] [1/4] helm install opensandbox-controller...
helm upgrade --install opensandbox-controller "%CHART_C_S%" --kubeconfig "%KUBE_S%" --namespace opensandbox-system --create-namespace --set controller.snapshot.containerdSocketPath="" --wait --timeout 5m
if errorlevel 1 ( echo controller install failed & goto :err )

echo [INFO] [2/4] ensure namespace opensandbox + batchsandbox ConfigMap...
kubectl --kubeconfig "%KUBE_S%" get namespace opensandbox >NUL 2>&1 || kubectl --kubeconfig "%KUBE_S%" create namespace opensandbox
kubectl --kubeconfig "%KUBE_S%" create configmap opensandbox-batchsandbox-template -n opensandbox-system --from-file=batchsandbox-template.yaml="%BATCH_S%" --dry-run=client -o yaml | kubectl --kubeconfig "%KUBE_S%" apply -f -
if errorlevel 1 ( echo batchsandbox ConfigMap apply failed & goto :err )

echo [INFO] [3/4] helm install opensandbox-server...
helm upgrade --install opensandbox-server "%CHART_S_S%" --kubeconfig "%KUBE_S%" --namespace opensandbox-system -f "%VALUES_S%" --set-file configToml="%TOML_S%" --wait --timeout 5m
if errorlevel 1 ( echo server install failed & goto :err )

echo [INFO] [4/4] patch opensandbox-server svc to NodePort 30080...
kubectl --kubeconfig "%KUBE_S%" patch svc opensandbox-server -n opensandbox-system --type=merge -p "{\"spec\":{\"type\":\"NodePort\",\"ports\":[{\"port\":80,\"targetPort\":\"http\",\"nodePort\":30080,\"protocol\":\"TCP\",\"name\":\"http\"}]}}"
if errorlevel 1 ( echo NodePort patch failed & goto :err )

REM --- 5. wire .env (read api_key from server-config.toml) ---
set "API_KEY="
for /f "usebackq tokens=2 delims==" %%K in (`findstr /b "api_key" "%TOML%"`) do (
  set "RAW=%%K"
  set "RAW=!RAW: =!"
  set "RAW=!RAW:"=!"
  set "API_KEY=!RAW!"
)
if "%API_KEY%"=="" ( echo Could not read api_key from %TOML% & goto :err )

call :setenv OPENSANDBOX_API_KEY "%API_KEY%"
call :setenv OPENSANDBOX_SERVER_URL "http://opensandbox-k3s:30080"
call :setenv OPENSANDBOX_USE_PROXY "1"
echo [OK] Synced OPENSANDBOX_API_KEY + SERVER_URL ^(opensandbox-k3s:30080^) into .env.

REM --- 6. start crewmeld ---
echo [INFO] Starting crewmeld (+ db/redis/migrations)...
if defined RECREATE (
  docker compose up -d --force-recreate
) else (
  docker compose up -d --force-recreate crewmeld
)
if errorlevel 1 ( echo crewmeld startup failed. Check: docker compose logs crewmeld & goto :err )

REM --- 7. verify ---
echo [INFO] Verifying server /health from inside the crewmeld container...
timeout /t 5 /nobreak >NUL
docker compose exec -T crewmeld sh -c "curl -fsS http://opensandbox-k3s:30080/health || wget -qO- http://opensandbox-k3s:30080/health" >NUL 2>&1
if errorlevel 1 ( echo [WARN] Could not confirm /health; check manually. ) else ( echo [OK] OpenSandbox /health reachable from crewmeld. )

echo.
echo [OK] Crewmeld (k3s runtime) is starting at http://localhost:6100
echo      OpenSandbox server: http://opensandbox-k3s:30080 (in compose network)
echo      Enable Dev Studio:  set DEV_STUDIO_ENABLED=1 in .env, then k3sStart.bat --recreate
echo      Logs: docker compose logs -f crewmeld
echo      Stop: docker compose --profile opensandbox down
popd
endlocal
exit /b 0

REM ---- setenv KEY VALUE : replace-or-append in .env ----
:setenv
set "K=%~1"
set "V=%~2"
findstr /b "%K%=" .env >NUL 2>&1
if errorlevel 1 (
  >>.env echo %K%=%V%
) else (
  powershell -NoProfile -Command "$r = Get-Content .env -Raw; $r = $r -replace '(?m)^%K%=.*', '%K%=%V%'; Set-Content .env -Value $r -NoNewline"
)
goto :eof

:err
echo.
echo  ^>^>^> k3sStart FAILED. See messages above. ^<^<^<
popd
endlocal
exit /b 1
