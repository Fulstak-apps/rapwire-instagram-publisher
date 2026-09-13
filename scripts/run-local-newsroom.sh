#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."

# Match the stable SportsWire model: an advisory OS lock owns the whole pass.
# It is released automatically on every exit, including crashes, so a stale
# directory can never block RapWire for hours.
if [[ -z "${RAPWIRE_WORKER_LOCK_HELD:-}" ]]; then
  exec /usr/bin/python3 scripts/with-worker-lock.py "$0" "$@"
fi

PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
export OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:4b}"
export RAPWIRE_AUTONOMOUS="${RAPWIRE_AUTONOMOUS:-1}"
export RAPWIRE_QA_THRESHOLD="${RAPWIRE_QA_THRESHOLD:-88}"
export RAPWIRE_AUTONOMOUS_SCORE="${RAPWIRE_AUTONOMOUS_SCORE:-92}"

# Health and dry-run modes remain strictly read-only.
for argument in "$@"; do
  if [[ "$argument" == "--health" || "$argument" == "--dry-run" ]]; then
    "$PYTHON_BIN" scripts/local-rapwire-autonomous.py "$argument"
    exit $?
  fi
done

# Narro has been retired.  The local runner is now dedicated to the approved
# Instagram-video collector; verified editorial-news batches are handled by
# the separate Google News / local-editor flow, not this five-minute loop.
"$PYTHON_BIN" scripts/repost-monitor-runner.py

# The collector owns queue commits. Publishing is left to the one scheduled
# GitHub publisher, just as SportsWire does—no overlapping local dispatches.
