#!/usr/bin/env bash
set -euo pipefail
hold="logs/publication-state-hold.json"
if [ -f "$hold" ]; then
  # A hold is only safety-critical when the prior publish step actually
  # succeeded. Failed/cancelled runs cannot have produced a publish ID and
  # must not block the queue indefinitely.
  held_publish=$(jq -r '.publish_result // "unknown"' "$hold" 2>/dev/null || echo unknown)
  if [ "$held_publish" != "success" ]; then
    rm -f "$hold"
  else
    echo "::error::Publication state needs reconciliation. See logs/publication-state-hold.json; do not duplicate a possibly published post."
    exit 1
  fi
fi
if ! previous=$(timeout 45s gh api "repos/$GITHUB_REPOSITORY/actions/workflows/publish-instagram.yml/runs?status=completed&per_page=1" --jq '.workflow_runs[0].id // empty'); then
  echo "Unable to inspect prior publication state within 45 seconds; retrying on the next publisher run." >&2
  exit 1
fi
if [ -z "$previous" ]; then exit 0; fi
if ! jobs=$(timeout 45s gh api "repos/$GITHUB_REPOSITORY/actions/runs/$previous/jobs"); then
  echo "Unable to inspect jobs for prior publisher run $previous within 45 seconds; retrying later." >&2
  exit 1
fi
save_result=$(jq -r '[.jobs[].steps[]? | select(.name == "Save publication log") | .conclusion][0] // "missing"' <<< "$jobs")
publish_result=$(jq -r '[.jobs[].steps[]? | select(.name == "Publish queued post to Instagram and Threads") | .conclusion][0] // "skipped"' <<< "$jobs")
if [[ "$publish_result" == "success" && "$save_result" != "success" ]]; then
  mkdir -p logs
  jq -n --arg run "$previous" --arg state "$save_result" --arg publish "$publish_result" '{run_id:$run,save_result:$state,publish_result:$publish,reason:"Prior publication state was not saved; recover its artifact and reconcile media IDs before resuming"}' > "$hold"
  echo "::error::Prior run $previous did not save publication state. Recovery required; publishing held to prevent duplicates."
  exit 1
fi
