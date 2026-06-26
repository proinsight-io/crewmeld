#!/usr/bin/env bash
# Launch the OpenSandbox server as a HOST process, Docker runtime.
#
# Installs-and-runs the server with uvx (no source checkout, no manual pip, no
# k3s) on 0.0.0.0:30080 so the crewmeld container reaches it at
# http://host.docker.internal:30080:
#
#   uvx opensandbox-server@0.1.14 --config opensandbox-server.docker.toml
#
# The api_key is injected via OPENSANDBOX_SERVER_API_KEY, resolved (in order)
# from <deploy>/server-config.toml, a repo-local .opensandbox-server-key, or
# freshly generated and persisted there. miniStart uses the SAME resolver.
#
# Runs in the FOREGROUND (it is a server). Ctrl+C to stop.
#
# Usage: ./serverStart.sh
set -euo pipefail
cd "$(dirname "$0")"

resolve_api_key() {
  local deploy_rel toml local_key k
  deploy_rel="${OPENSANDBOX_DEPLOY_DIR:-}"
  if [[ -z "$deploy_rel" && -f .env ]]; then
    deploy_rel="$(sed -n 's/^[[:space:]]*OPENSANDBOX_DEPLOY_DIR=\(.*\)$/\1/p' .env | head -n1)"
  fi
  [[ -n "$deploy_rel" ]] || deploy_rel="../opensandbox-deploy"
  if toml="$(cd "$deploy_rel" 2>/dev/null && pwd)/server-config.toml" && [[ -f "$toml" ]]; then
    k="$(sed -n 's/^[[:space:]]*api_key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$toml" | head -n1)"
    if [[ -n "$k" ]]; then echo "$k"; return 0; fi
  fi
  local_key=".opensandbox-server-key"
  if [[ -f "$local_key" ]]; then
    k="$(tr -d '[:space:]' < "$local_key")"
    if [[ -n "$k" ]]; then echo "$k"; return 0; fi
  fi
  if command -v openssl >/dev/null 2>&1; then
    k="$(openssl rand -hex 32)"
  else
    k="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf '%s' "$k" > "$local_key"
  echo "[INFO] Generated a new OpenSandbox api_key -> .opensandbox-server-key" >&2
  echo "$k"
}

server_up() { curl -fsS -o /dev/null --max-time 3 http://localhost:30080/health 2>/dev/null; }

command -v uvx >/dev/null 2>&1 || {
  echo "uvx not found on PATH. Install uv: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
}

if server_up; then
  echo "[INFO] OpenSandbox server already responding on :30080 — nothing to do."
  exit 0
fi

OPENSANDBOX_SERVER_API_KEY="$(resolve_api_key)"
export OPENSANDBOX_SERVER_API_KEY
CONFIG="$(pwd)/opensandbox-server.docker.toml"
echo "[INFO] Starting OpenSandbox server (uvx, Docker runtime) on 0.0.0.0:30080..."
echo "       config: $CONFIG"
echo "       Ctrl+C to stop. crewmeld reaches it at http://host.docker.internal:30080"
exec uvx opensandbox-server@0.1.14 --config "$CONFIG"
