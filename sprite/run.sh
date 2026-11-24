#!/usr/bin/env bash
# Service entry point. Loads connector URLs from ~/hive/hive.env (not in git), then starts Hive.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f hive.env ]; then set -a; . ./hive.env; set +a; fi
export PORT="${PORT:-8080}" HIVE_DATA_DIR="${HIVE_DATA_DIR:-$PWD/data}" SPRITE_NAME="${SPRITE_NAME:-hive}"
exec "$(command -v node || echo /.sprite/bin/node)" src/server.ts
