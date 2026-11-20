#!/usr/bin/env bash
# Build, then run one Forgelight task headlessly against the local TrueForge.
# Example:
#   scripts/headless-task.sh --root ../forge-a-thon-sandbox/flask --mode inline \
#     --file src/flask/helpers.py --lines 28-33 --task "Treat 'off' as false"
set -euo pipefail
cd "$(dirname "$0")/.."
node esbuild.mjs >/dev/null
exec node dist/test/headless/runTask.js "$@"
