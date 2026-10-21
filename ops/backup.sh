#!/usr/bin/env bash
# Back up the whole installation: the control-plane database (owner
# account, computers, tokens, audit) plus every computer's home volume.
#
# Usage: ops/backup.sh [output-dir]     (default ./backups/<timestamp>)
# Run from the deployment directory (where docker-compose.yml lives),
# as a user who can read /var/lib/docker/volumes (usually root/sudo).
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-agentcomputer}"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
OUT="${1:-./backups/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

echo ">> stopping the control plane for a consistent database snapshot"
docker compose stop control-plane >/dev/null

cleanup() { docker compose start control-plane >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo ">> copying control-plane data volume"
docker run --rm -v "${PROJECT}_acp-data":/data:ro -v "$PWD/$OUT":/out alpine \
  sh -c 'cp -a /data/. /out/control-plane-data/ 2>/dev/null || (mkdir -p /out/control-plane-data && cp -a /data/. /out/control-plane-data/)'

echo ">> archiving computer home volumes from $DOCKER_ROOT/volumes"
FOUND=0
for vol in "$DOCKER_ROOT"/volumes/${PROJECT}_acp-*-home "$DOCKER_ROOT"/volumes/acp-*-home; do
  [ -d "$vol/_data" ] || continue
  name="$(basename "$vol")"
  tar -czf "$OUT/${name}.tar.gz" -C "$vol" _data
  echo "   - $name"
  FOUND=1
done
[ "$FOUND" = "1" ] || echo "   (no computer volumes found)"

echo ">> writing manifest"
{
  echo "created: $(date -Is)"
  echo "project: $PROJECT"
  echo "docker_root: $DOCKER_ROOT"
  ls -la "$OUT"
} > "$OUT/MANIFEST.txt"

trap - EXIT
cleanup
echo "Backup complete: $OUT"
