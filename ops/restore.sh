#!/usr/bin/env bash
# Restore an installation from a backup made by ops/backup.sh.
#
# Usage: ops/restore.sh <backup-dir> [--yes]
#
# WARNING: this REPLACES the current control-plane database and the
# contents of the computer home volumes named in the backup. Computers
# should be asleep/stopped; the script stops the whole stack first.
set -euo pipefail

SRC="${1:?usage: ops/restore.sh <backup-dir> [--yes]}"
[ "${2:-}" = "--yes" ] || { echo "This replaces current data. Re-run with --yes to proceed."; exit 1; }
[ -d "$SRC/control-plane-data" ] || { echo "not a backup dir (missing control-plane-data): $SRC"; exit 1; }

PROJECT="${COMPOSE_PROJECT_NAME:-agentcomputer}"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"

echo ">> stopping the stack"
docker compose down >/dev/null 2>&1 || true
for c in $(docker ps -a --filter label=acp.managed=true --format '{{.Names}}'); do
  echo "   stopping computer container $c"
  docker stop "$c" >/dev/null 2>&1 || true
done

echo ">> restoring control-plane data volume"
docker volume create "${PROJECT}_acp-data" >/dev/null
docker run --rm -v "${PROJECT}_acp-data":/data -v "$PWD/$SRC":/in alpine \
  sh -c 'rm -rf /data/* && cp -a /in/control-plane-data/. /data/'

echo ">> restoring computer home volumes"
for tgz in "$SRC"/*-home.tar.gz; do
  [ -f "$tgz" ] || continue
  name="$(basename "$tgz" .tar.gz)"
  mkdir -p "$DOCKER_ROOT/volumes/$name"
  tar -xzf "$tgz" -C "$DOCKER_ROOT/volumes/$name"
  echo "   - $name"
done

echo ">> starting the stack"
docker compose up -d >/dev/null
echo "Restore complete. Computers reconcile their state on boot; wake them from the dashboard."
