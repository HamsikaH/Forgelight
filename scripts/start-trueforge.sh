#!/usr/bin/env bash
# Starts TrueForge in local (standalone) mode on http://localhost:8790.
# Local mode blocks outbound requests to localhost by default (SSRF guard).
# Forgelight needs two local hosts reachable from TrueForge:
#   - the extension's MCP tool server (http://127.0.0.1:<port>/mcp)
#   - an optional local model server such as Ollama (http://localhost:11434/v1)
# so we allow exactly those loopback hosts and nothing else.
#
# TrueForge waits at most 20 s for a model's response headers (then retries twice and fails the
# turn). A local model sends no headers until it has loaded and read the whole prompt, which can
# take longer for long agent prompts or a cold model, so the limits are raised here.
#
# The version is pinned to the one Forgelight was tested with; TRUEFORGE_VERSION=latest opts in
# to the newest release.
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'
export MODEL_HTTP_HEADERS_TIMEOUT_MS="${MODEL_HTTP_HEADERS_TIMEOUT_MS:-600000}"
export MODEL_HTTP_BODY_TIMEOUT_MS="${MODEL_HTTP_BODY_TIMEOUT_MS:-300000}"
exec npx -y "@truefoundry/trueforge@${TRUEFORGE_VERSION:-0.185.1}" "$@"
