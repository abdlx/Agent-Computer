#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/recovery.py" backup "${1:-./backups/$(date +%Y%m%d-%H%M%S)}"
