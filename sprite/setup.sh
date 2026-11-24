#!/usr/bin/env bash
# Run INSIDE the Sprite (sprite console, or the Sprites MCP exec tool).
# Installs Hive and registers it as a Sprite service that owns the Sprite's URL.
#
#   HIVE_LLM_GATEWAY   OpenRouter connector URL ending in /v1 (from the connector's detail page)
#   HIVE_SLACK_GATEWAY Slack connector URL (optional)
#   HIVE_MODEL         OpenRouter model id (optional)
set -euo pipefail

REPO="${HIVE_REPO:-https://github.com/veerefines/hive-sprite}"
DIR="${HIVE_DIR:-$HOME/hive}"
: "${HIVE_LLM_GATEWAY:?set HIVE_LLM_GATEWAY to your OpenRouter connector URL}"

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi

NODE="$(command -v node)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) {console.error("Node >= 22.18 needed for type stripping, found "+process.versions.node); process.exit(1)}'

# Connector URLs live in hive.env (git-ignored), read by sprite/run.sh at start.
{
  echo "HIVE_LLM_GATEWAY=$HIVE_LLM_GATEWAY"
  [ -n "${HIVE_SLACK_GATEWAY:-}" ] && echo "HIVE_SLACK_GATEWAY=$HIVE_SLACK_GATEWAY"
  [ -n "${HIVE_MODEL:-}" ] && echo "HIVE_MODEL=$HIVE_MODEL"
} > "$DIR/hive.env"

sprite-env services delete hive >/dev/null 2>&1 || true
sprite-env services create hive --cmd "$DIR/sprite/run.sh" --http-port 8080 --duration 8s

curl -fsS localhost:8080/api/health && echo
echo "Hive is up. Make the URL public with: sprite url update --auth public"
