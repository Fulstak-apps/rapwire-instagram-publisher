#!/bin/zsh
set -euo pipefail

# RapWire local autonomous newsroom runner.
# Keeps overlapping launchd runs from stacking up.

RAPWIRE_REPO_DIR="${RAPWIRE_REPO:-$HOME/Library/Application Support/RapWire/publisher-runtime}"
LOCK="${TMPDIR:-/tmp}/rapwire247-newsroom.lock"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"

# The previous directory-only lock could survive a crash forever.  Every later
# launchd pass then treated the newsroom as busy and silently skipped it.  Keep
# the owning PID in the lock and recover only a provably dead owner.
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    print -r -- "$$" > "$LOCK/pid"
    return 0
  fi

  local owner=""
  [[ -r "$LOCK/pid" ]] && owner=$(<"$LOCK/pid")
  if [[ "$owner" == <-> ]] && kill -0 "$owner" 2>/dev/null; then
    echo "RapWire newsroom already running (pid $owner); skipping overlap."
    return 1
  fi

  # The only expected lock member is pid.  Do not remove an unexpected
  # directory; that would hide a manual intervention instead of recovering.
  rm -f "$LOCK/pid"
  if ! rmdir "$LOCK" 2>/dev/null || ! mkdir "$LOCK" 2>/dev/null; then
    echo "RapWire newsroom lock is not safely recoverable: $LOCK" >&2
    return 1
  fi
  print -r -- "$$" > "$LOCK/pid"
}

release_lock() {
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || true
}

acquire_lock || exit 0
trap 'release_lock' EXIT

cd "$RAPWIRE_REPO_DIR"
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
  # The local runtime uses sparse checkout. Captured video assets are outside
  # its normal cone, so stage them explicitly or a valid post is stranded.
  git add --sparse -- queue media
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
