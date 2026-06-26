#!/usr/bin/env bash
#
# Crewmeld DESTRUCTIVE reset — removes containers, volumes, and local artifacts.
#
# Usage: ./reset.sh [--yes|-y] [docker compose flags]
# Examples:
#   ./reset.sh
#   ./reset.sh --yes
#   ./reset.sh --yes --profile opensandbox --profile minio --profile ragflow --profile ollama

set -euo pipefail

AUTO_YES=0
COMPOSE_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --yes|-y) AUTO_YES=1 ;;
        *)        COMPOSE_ARGS+=("$arg") ;;
    esac
done

cat <<'EOF'

============================================================
 WARNING: This will permanently delete all Crewmeld data:
   - all containers in this compose project
   - all named volumes (postgres / redis / minio / opensandbox / ragflow / ollama)
   - local .env (regenerated on next start)
   - local autogen state (./shared, ./temp)
============================================================

EOF

if [[ "$AUTO_YES" -eq 0 ]]; then
    read -r -p "Type 'yes' to continue: " CONFIRM
    if [[ "$CONFIRM" != "yes" ]]; then
        echo "[INFO] Aborted."
        exit 1
    fi
fi

# Phase 1: Down with all profiles + volumes (best effort)
echo "[INFO] Stopping containers and removing volumes..."
docker compose "${COMPOSE_ARGS[@]}" \
    --profile init \
    --profile opensandbox \
    --profile minio \
    --profile ragflow \
    --profile ollama \
    --profile ollama-cpu \
    --profile ollama-setup \
    down -v --remove-orphans || true

# Phase 2: Prune any leftover named volumes
echo "[INFO] Pruning leftover crewmeld volumes..."
while IFS= read -r vol; do
    [[ -z "$vol" ]] && continue
    echo "   - removing $vol"
    docker volume rm "$vol" >/dev/null 2>&1 || true
done < <(docker volume ls -q --filter "name=crewmeld_")

# Phase 3: Local artifacts
echo "[INFO] Removing local artifacts..."
for path in .env autogen.env shared/autogen.env temp; do
    if [[ -e "$path" ]]; then
        rm -rf "$path"
        echo "   - $path"
    fi
done

echo ""
echo "[OK] Reset complete. Run ./start.sh to bootstrap a fresh environment."
exit 0
