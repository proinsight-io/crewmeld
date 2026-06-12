#!/usr/bin/env bash
#
# Crewmeld one-click startup
#
# Usage: ./start.sh [docker compose flags]
# Examples:
#   ./start.sh
#   ./start.sh --profile opensandbox --profile minio
#   ./start.sh --profile opensandbox --profile minio --profile ragflow --profile ollama

set -euo pipefail

# Ensure .env exists (only copy if missing)
if [[ ! -f .env ]]; then
    echo "[INFO] Creating .env from .env.example..."
    if [[ ! -f .env.example ]]; then
        echo "ERROR: .env.example not found, cannot bootstrap .env" >&2
        exit 1
    fi
    cp .env.example .env
else
    echo "[INFO] .env already exists, skipping copy."
fi

# Generate OPENSANDBOX_API_KEY at first deploy (host-side; NOT baked into the
# image). Shared by crewmeld and the docker-runtime OpenSandbox server. Skipped
# once a non-empty value exists.
if ! grep -qE '^OPENSANDBOX_API_KEY=.+' .env; then
    if command -v openssl >/dev/null 2>&1; then
        OSKEY="$(openssl rand -hex 32)"
    else
        OSKEY="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    if grep -qE '^OPENSANDBOX_API_KEY=' .env; then
        sed -i.bak "s#^OPENSANDBOX_API_KEY=.*#OPENSANDBOX_API_KEY=${OSKEY}#" .env && rm -f .env.bak
    else
        printf '\nOPENSANDBOX_API_KEY=%s\n' "$OSKEY" >> .env
    fi
    echo "[INFO] Generated OPENSANDBOX_API_KEY (first deploy)."
fi

# Phase 1: Generate secrets (idempotent — skips if already filled)
echo "[INFO] Ensuring secrets (docker compose --profile init run --rm setup)..."
docker compose --profile init run --rm setup

# Phase 2: Start all services with user-supplied profile flags
echo "[INFO] Starting services (docker compose $* up -d)..."
docker compose "$@" up -d

echo ""
echo "[OK] Crewmeld is starting at ${NEXT_PUBLIC_APP_URL:-http://localhost:6100}"
echo "     Logs: docker compose logs -f crewmeld"
echo "     Stop: docker compose down"
