#!/bin/zsh
set -euo pipefail

REPO="Fulstak-apps/rapwire-instagram-publisher"
WORKFLOW="publish-instagram.yml"
GH="/opt/homebrew/bin/gh"

print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) scheduler check"

# Avoid stacking duplicate runs if a prior publish is still processing.
ACTIVE=$("$GH" run list --repo "$REPO" --workflow "$WORKFLOW" --limit 20 --json status --jq '[.[] | select(.status == "in_progress" or .status == "queued" or .status == "pending" or .status == "waiting")] | length')
if [[ "$ACTIVE" != "0" ]]; then
  print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) skipped: workflow already running"
  exit 0
fi

RUN_URL=$("$GH" workflow run "$WORKFLOW" --repo "$REPO" --ref main)
print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) dispatched: $RUN_URL"
