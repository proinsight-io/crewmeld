#!/usr/bin/env bash
# Crewmeld one-click startup with the OpenSandbox k3s runtime.
#
# End to end: ensure .env + secrets -> start k3s node + db/redis -> wait Ready ->
# helm-install controller + server into k3s, create namespaces / batchsandbox
# ConfigMap, patch the service to NodePort 30080 -> copy api_key from
# <deploy>/server-config.toml into .env (point SERVER_URL at opensandbox-k3s:30080)
# -> start crewmeld -> verify /health from inside the crewmeld container.
#
# Usage: ./k3sStart.sh [--recreate]
set -euo pipefail
cd "$(dirname "$0")"

RECREATE=0
[[ "${1:-}" == "--recreate" ]] && RECREATE=1

# --- helpers ---
get_env() { # get_env KEY  -> value from .env (empty if absent)
  [[ -f .env ]] || return 0
  sed -n "s/^[[:space:]]*$1=\(.*\)$/\1/p" .env | head -n1
}
set_env() { # set_env KEY VALUE  (replace in place or append)
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    # Use a non-/ delimiter; values may contain slashes.
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

# --- 0. tooling ---
for tool in docker kubectl helm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool not found on PATH: $tool" >&2; exit 1; }
done

# --- 1. .env + secrets ---
if [[ ! -f .env ]]; then
  echo "[INFO] Creating .env from .env.example..."
  [[ -f .env.example ]] || { echo ".env.example not found" >&2; exit 1; }
  cp .env.example .env
else
  echo "[INFO] .env already exists, skipping copy."
fi

echo "[INFO] Ensuring secrets (docker compose --profile init run --rm setup)..."
docker compose --profile init run --rm setup

# --- resolve deploy dir ---
DEPLOY_REL="${OPENSANDBOX_DEPLOY_DIR:-$(get_env OPENSANDBOX_DEPLOY_DIR)}"
[[ -n "$DEPLOY_REL" ]] || DEPLOY_REL="../opensandbox-deploy"
DEPLOY_DIR="$(cd "$DEPLOY_REL" 2>/dev/null && pwd)" || { echo "Deploy dir not found: $DEPLOY_REL" >&2; exit 1; }

KUBE="$DEPLOY_DIR/.kube/config"
TOML="$DEPLOY_DIR/server-config.toml"
VALUES="$DEPLOY_DIR/server-values.yaml"
BATCH="$DEPLOY_DIR/batchsandbox-template.yaml"
CHART_C="$DEPLOY_DIR/charts/opensandbox-controller"
CHART_S="$DEPLOY_DIR/charts/opensandbox-server"
for p in "$TOML" "$VALUES" "$BATCH" "$CHART_C" "$CHART_S"; do
  [[ -e "$p" ]] || { echo "Missing deploy artifact: $p" >&2; exit 1; }
done

# --- 2. start k3s + core ---
echo "[INFO] Starting opensandbox-k3s + db + redis..."
UP=(--profile opensandbox up -d opensandbox-k3s db redis)
[[ $RECREATE -eq 1 ]] && UP+=(--force-recreate)
docker compose "${UP[@]}"

# --- 3. wait Ready ---
echo "[INFO] Waiting for k3s to become Ready (kubeconfig: $KUBE)..."
ready=0
for i in $(seq 1 60); do
  if [[ -f "$KUBE" ]] && kubectl --kubeconfig "$KUBE" get nodes --no-headers 2>/dev/null | grep -q ' Ready'; then
    ready=1; break
  fi
  sleep 5
  echo "  ...still waiting ($((i * 5))s)"
done
[[ $ready -eq 1 ]] || { echo "k3s did not become Ready. Check: docker compose logs opensandbox-k3s" >&2; exit 1; }
echo "[OK] k3s is Ready."

# --- 4. install OpenSandbox ---
echo "[INFO] [1/4] helm install opensandbox-controller..."
helm upgrade --install opensandbox-controller "$CHART_C" \
  --kubeconfig "$KUBE" \
  --namespace opensandbox-system --create-namespace \
  --set controller.snapshot.containerdSocketPath="" \
  --wait --timeout 5m

echo "[INFO] [2/4] ensure namespace opensandbox + batchsandbox ConfigMap..."
kubectl --kubeconfig "$KUBE" get namespace opensandbox >/dev/null 2>&1 \
  || kubectl --kubeconfig "$KUBE" create namespace opensandbox
kubectl --kubeconfig "$KUBE" create configmap opensandbox-batchsandbox-template \
  -n opensandbox-system \
  --from-file=batchsandbox-template.yaml="$BATCH" \
  --dry-run=client -o yaml | kubectl --kubeconfig "$KUBE" apply -f -

echo "[INFO] [3/4] helm install opensandbox-server..."
helm upgrade --install opensandbox-server "$CHART_S" \
  --kubeconfig "$KUBE" \
  --namespace opensandbox-system \
  -f "$VALUES" \
  --set-file configToml="$TOML" \
  --wait --timeout 5m

echo "[INFO] [4/4] patch opensandbox-server svc to NodePort 30080..."
kubectl --kubeconfig "$KUBE" patch svc opensandbox-server -n opensandbox-system --type=merge \
  -p '{"spec":{"type":"NodePort","ports":[{"port":80,"targetPort":"http","nodePort":30080,"protocol":"TCP","name":"http"}]}}'

# --- 5. wire .env ---
API_KEY="$(sed -n 's/^[[:space:]]*api_key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TOML" | head -n1)"
[[ -n "$API_KEY" ]] || { echo "Could not read api_key from $TOML" >&2; exit 1; }
set_env OPENSANDBOX_API_KEY "$API_KEY"
set_env OPENSANDBOX_SERVER_URL "http://opensandbox-k3s:30080"
set_env OPENSANDBOX_USE_PROXY "1"
echo "[OK] Synced OPENSANDBOX_API_KEY + SERVER_URL (opensandbox-k3s:30080) into .env."

# --- 6. start crewmeld ---
echo "[INFO] Starting crewmeld (+ db/redis/migrations)..."
if [[ $RECREATE -eq 1 ]]; then
  docker compose up -d --force-recreate
else
  docker compose up -d --force-recreate crewmeld
fi

# --- 7. verify ---
echo "[INFO] Verifying server /health from inside the crewmeld container..."
sleep 5
if docker compose exec -T crewmeld sh -c "curl -fsS http://opensandbox-k3s:30080/health || wget -qO- http://opensandbox-k3s:30080/health" >/dev/null 2>&1; then
  echo "[OK] OpenSandbox /health reachable from crewmeld."
else
  echo "[WARN] Could not confirm /health (curl/wget may be absent in image); check manually."
fi

APP_URL="${NEXT_PUBLIC_APP_URL:-http://localhost:6100}"
echo ""
echo "[OK] Crewmeld (k3s runtime) is starting at $APP_URL"
echo "     OpenSandbox server: http://opensandbox-k3s:30080 (in compose network)"
echo "     Enable Dev Studio:  set DEV_STUDIO_ENABLED=1 in .env, then ./k3sStart.sh --recreate"
echo "     Logs: docker compose logs -f crewmeld"
echo "     Stop: docker compose --profile opensandbox down"
