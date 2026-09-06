#!/bin/zsh
set -euo pipefail

# RapWire local autonomous newsroom runner.
# Keeps overlapping launchd runs from stacking up.

RAPWIRE_REPO_DIR="${RAPWIRE_REPO:-$HOME/Library/Application Support/RapWire/publisher-runtime}"
LOCK="${TMPDIR:-/tmp}/rapwire247-newsroom.lock"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "RapWire newsroom already running; skipping overlap."
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

cd "$RAPWIRE_REPO_DIR"
export OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:4b}"
export RAPWIRE_AUTONOMOUS="${RAPWIRE_AUTONOMOUS:-1}"
export RAPWIRE_QA_THRESHOLD="${RAPWIRE_QA_THRESHOLD:-88}"
export RAPWIRE_AUTONOMOUS_SCORE="${RAPWIRE_AUTONOMOUS_SCORE:-92}"

"$PYTHON_BIN" scripts/local-rapwire-autonomous.py "$@"

# Health and dry-run modes are strictly read-only.
for argument in "$@"; do
  [[ "$argument" == "--health" || "$argument" == "--dry-run" ]] && exit 0
done

# This is a local, no-Codex-credit recovery check. The local newsroom has just
# completed its Ollama cycle; the watchdog only uses deterministic queue and
# pacing state, then asks GitHub to retry once if a feed window was genuinely
# missed. Meta cooldowns, quotas, and uncertain containers remain untouched.
node scripts/publisher-watchdog.mjs
WATCHDOG_DISPATCH=$(node -e 'const fs=require("fs");try{console.log(JSON.parse(fs.readFileSync("logs/publisher-watchdog.json","utf8")).dispatch ? "true" : "false")}catch{console.log("false")}')

# Push newly prepared queue state so the existing GitHub Actions publisher can see it.
# Never force-push. If the repo changed remotely, rebase once and retry.
# Only publish durable content changes. Operational logs stay local and must never
# create a Git commit by themselves.
if [[ -n "$(git status --porcelain -- queue media 2>/dev/null)" ]]; then
  git add -- queue media
  git diff --cached --quiet && exit 0
  git commit -m "RapWire autonomous newsroom queue"
  git fetch origin main
  if ! git rebase --autostash origin/main; then
    echo "RapWire newsroom: rebase conflict; local commit retained. Resolve before retrying." >&2
    git rebase --abort || true
    exit 1
  fi
  if ! git push origin HEAD:main; then
    echo "RapWire newsroom: push failed; local commit retained for retry." >&2
    exit 1
  fi
fi

if [[ "$WATCHDOG_DISPATCH" == "true" ]]; then
  echo "RapWire watchdog: missed publishing window; requesting one safe retry."
  scripts/dispatch-publisher.sh
fi
