#!/usr/bin/env bash
# Runs an extra dev copy of BrewLM, with its own data folder, syncing through
# the local sync server — for testing BrewLM Sync on one machine.
#
#   1. cd sync-server && cp .dev.vars.example .dev.vars   (once; set a token)
#   2. cd sync-server && npm run dev                      (local server :8787)
#   3. npm run tauri dev                                  (builds the app, serves the UI)
#   4. scripts/sync-dev-copy.sh a   and   scripts/sync-dev-copy.sh b
#
# Each profile keeps its data in "<app data>/com.brewlm.app.<profile>", so the
# normal library is never touched. Profile names: letters and digits only.
set -euo pipefail

PROFILE="${1:?usage: scripts/sync-dev-copy.sh <profile>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$(sed -n 's/^SYNC_DEV_TOKEN=//p' "$ROOT/sync-server/.dev.vars" 2>/dev/null || true)"
[ -n "$TOKEN" ] || { echo "No SYNC_DEV_TOKEN in sync-server/.dev.vars (see step 1)." >&2; exit 1; }

export BREWLM_PROFILE="$PROFILE"
export BREWLM_SYNC_URL="${BREWLM_SYNC_URL:-http://127.0.0.1:8787}"
export BREWLM_SYNC_TOKEN="$TOKEN"
export BREWLM_SYNC_VAULT="${BREWLM_SYNC_VAULT:-dev}"
exec "$ROOT/src-tauri/target/debug/brewlm"
