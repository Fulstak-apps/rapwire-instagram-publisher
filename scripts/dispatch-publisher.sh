#!/bin/zsh
set -euo pipefail

REPO="Fulstak-apps/rapwire-instagram-publisher"
WORKFLOW="publish-instagram.yml"
GH="/opt/homebrew/bin/gh"

# Avoid stacking duplicate runs if a prior publish is still processing.
ACTIVE=$("$GH" run list --repo "$REPO" --workflow "$WORKFLOW" --status in_progress --limit 1 --json databaseId --jq 'length')
if [[ "$ACTIVE" != "0" ]]; then
  exit 0
fi

"$GH" workflow run "$WORKFLOW" --repo "$REPO" --ref main
