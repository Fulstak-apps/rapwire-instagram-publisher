#!/usr/bin/env bash
set -euo pipefail
hold="logs/publication-state-hold.json"
if [ -f "$hold" ]; then
  echo "::error::Publication state needs reconciliation. See logs/publication-state-hold.json; do not duplicate a possibly published post."
  exit 1
fi
previous=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/publish-instagram.yml/runs?status=completed&per_page=1" --jq '.workflow_runs[0].id // empty')
if [ -z "$previous" ]; then exit 0; fi
jobs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$previous/jobs")
save_result=$(jq -r '[.jobs[].steps[]? | select(.name == "Save publication log") | .conclusion][0] // "missing"' <<< "$jobs")
publish_result=$(jq -r '[.jobs[].steps[]? | select((.name | startswith("Publish queued post to Instagram")) or .name == "Engage substantive Threads replies") | .conclusion | select(. != "skipped" and . != null)][0] // "skipped"' <<< "$jobs")
if [[ "$publish_result" != "skipped" && "$save_result" != "success" ]]; then
  mkdir -p logs
  jq -n --arg run "$previous" --arg state "$save_result" '{run_id:$run,save_result:$state,reason:"Prior publication state was not saved; recover its artifact and reconcile media IDs before resuming"}' > "$hold"
  echo "::error::Prior run $previous did not save publication state. Recovery required; publishing held to prevent duplicates."
  exit 1
fi
