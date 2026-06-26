#!/usr/bin/env bash
# Crewmeld MINIMAL one-click: host OpenSandbox server + crewmeld + postgres +
# redis + MinIO — installed and running from a single command.
#
#   1. bootstrap .env + secrets + MinIO/OpenSandbox wiring
#   2. resolve the shared OpenSandbox api_key (single source of truth)
#   3. start the OpenSandbox server ON THE HOST in the background via uvx
#      (no source, no manual pip, no k3s) -> serverStart.sh, Docker runtime,
#      0.0.0.0:30080 -> wait until healthy
#   4. bring up crewmeld + db + redis + MinIO (+ bucket) in compose
#
# crewmeld reaches the host server at http://host.docker.internal:30080 and
# MinIO at http://minio:9000 (in-network). The containerized OpenSandbox
# "docker" runtime is intentionally NOT used (egress quirk 502s); a host process
# avoids that. To run the server in its own terminal instead, use ./serverStart.sh.
#
# Usage: ./miniStart.sh [--recreate]
set -euo pipefail
cd "$(dirname "$0")"

RECREATE=0
[[ "${1:-}" == "--recreate" ]] && RECREATE=1

get_env() {
  [[ -f .env ]] || return 0
  sed -n "s/^[[:space:]]*$1=\(.*\)$/\1/p" .env | head -n1
}
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
set_env_default() {
  local cur; cur="$(get_env "$1")"
  [[ -n "$cur" ]] || set_env "$1" "$2"
}

# Shared with serverStart.sh: resolve the OpenSandbox api_key. Resolving here
# first persists a generated key so the server reads the same one.
resolve_api_key() {
  local deploy_rel toml k
  deploy_rel="${OPENSANDBOX_DEPLOY_DIR:-$(get_env OPENSANDBOX_DEPLOY_DIR)}"
  [[ -n "$deploy_rel" ]] || deploy_rel="../opensandbox-deploy"
  if toml="$(cd "$deploy_rel" 2>/dev/null && pwd)/server-config.toml" && [[ -f "$toml" ]]; then
    k="$(sed -n 's/^[[:space:]]*api_key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$toml" | head -n1)"
    if [[ -n "$k" ]]; then echo "$k"; return 0; fi
  fi
  if [[ -f .opensandbox-server-key ]]; then
    k="$(tr -d '[:space:]' < .opensandbox-server-key)"
    if [[ -n "$k" ]]; then echo "$k"; return 0; fi
  fi
  if command -v openssl >/dev/null 2>&1; then k="$(openssl rand -hex 32)"; else k="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  printf '%s' "$k" > .opensandbox-server-key
  echo "[INFO] Generated a new OpenSandbox api_key -> .opensandbox-server-key" >&2
  echo "$k"
}

server_up() { curl -fsS -o /dev/null --max-time 3 http://localhost:30080/health 2>/dev/null; }

# --- 1. .env bootstrap ---
if [[ ! -f .env ]]; then
  echo "[INFO] Creating .env from .env.example..."
  [[ -f .env.example ]] || { echo ".env.example not found" >&2; exit 1; }
  cp .env.example .env
else
  echo "[INFO] .env already exists, skipping copy."
fi

# --- 2. auth secrets ---
echo "[INFO] Ensuring secrets (docker compose --profile init run --rm setup)..."
docker compose --profile init run --rm setup

# --- 3. wire MinIO + OpenSandbox into .env ---
set_env         MINIO_ENDPOINT          "http://minio:9000"
set_env         MINIO_EXTERNAL_ENDPOINT "http://host.docker.internal:9000"
set_env_default MINIO_ACCESS_KEY        "rag_flow"
set_env_default MINIO_SECRET_KEY        "infini_rag_flow"
set_env_default MINIO_BUCKET            "tool-files"
set_env         OPENSANDBOX_SERVER_URL  "http://host.docker.internal:30080"
# USE_PROXY=0: a host-run server on Docker Desktop cannot proxy to sandbox bridge
# IPs, so crewmeld connects DIRECTLY to each sandbox's published host port (the
# server returns host.docker.internal:<port> via eip in the server config).
set_env         OPENSANDBOX_USE_PROXY   "0"
API_KEY="$(resolve_api_key)"
set_env OPENSANDBOX_API_KEY "$API_KEY"
echo "[OK] Wired MinIO (minio:9000) + OpenSandbox (host.docker.internal:30080) + api_key into .env."

# --- 4. start the host OpenSandbox server (background) ---
if server_up; then
  echo "[INFO] OpenSandbox server already up on :30080."
else
  command -v uvx >/dev/null 2>&1 || {
    echo "uvx not found; cannot start the OpenSandbox server. Install uv (https://docs.astral.sh/uv/) or run ./serverStart.sh yourself." >&2
    exit 1
  }
  echo "[INFO] Launching OpenSandbox server in background (uvx) -> opensandbox-server.log"
  nohup ./serverStart.sh > opensandbox-server.log 2>&1 &
  for i in $(seq 1 90); do server_up && break; sleep 2; done
  server_up || { echo "OpenSandbox server did not become healthy; check opensandbox-server.log" >&2; exit 1; }
  echo "[OK] OpenSandbox server healthy on :30080."
fi

# --- 5. bring up the minimal stack (core + MinIO) ---
echo "[INFO] Starting minimal stack (crewmeld + pg + redis + MinIO)..."
UP=(--profile minio up -d)
[[ $RECREATE -eq 1 ]] && UP+=(--force-recreate)
docker compose "${UP[@]}"

# --- 6. notes ---
APP_URL="${NEXT_PUBLIC_APP_URL:-http://localhost:6100}"
echo ""
echo "[OK] Crewmeld minimal stack is starting at $APP_URL"
echo "     MinIO:       http://minio:9000 (in-network)  /  console http://localhost:9001"
echo "     OpenSandbox: host process on :30080 (logs: opensandbox-server.log)"
echo "     Logs: docker compose logs -f crewmeld"
echo "     Stop: docker compose --profile minio down   (then stop the host server: kill the uvx process)"
