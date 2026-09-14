#!/usr/bin/env bash
set -euo pipefail
hold="logs/publication-state-hold.json"
if [ -f "$hold" ]; then
  # A hold is only safety-critical when the prior publish step actually
  # succeeded. Failed/cancelled runs cannot have produced a publish ID and
  # must not block the queue indefinitely.
  held_publish=$(jq -r '.publish_result // "unknown"' "$hold" 2>/dev/null || echo unknown)
  held_run=$(jq -r '.run_id // empty' "$hold" 2>/dev/null || true)
  held_conclusion="unknown"
  if [ -n "$held_run" ]; then
    held_conclusion=$(timeout 45s gh api "repos/$GITHUB_REPOSITORY/actions/runs/$held_run" --jq '.conclusion // "unknown"' 2>/dev/null || echo unknown)
  fi
  # Holds written by an older cancelled/timed-out run must not freeze the
  # queue. The next publisher pass resumes saved containers and rechecks Meta.
  if [ "$held_publish" != "success" ] || [ "$held_conclusion" = "cancelled" ] || [ "$held_conclusion" = "timed_out" ]; then
    echo "Clearing non-success publication hold for run ${held_run:-unknown} (${held_conclusion})."
    rm -f "$hold"
  else
    echo "::error::Publication state needs reconciliation. See logs/publication-state-hold.json; do not duplicate a possibly published post."
    exit 1
  fi
fi
if ! previous_meta=$(timeout 45s gh api "repos/$GITHUB_REPOSITORY/actions/workflows/publish-instagram.yml/runs?status=completed&per_page=1" --jq '.workflow_runs[0] | {id,conclusion,event}'); then
  echo "Unable to inspect prior publication state within 45 seconds; retrying on the next publisher run." >&2
  exit 1
fi
previous=$(jq -r '.id // empty' <<< "$previous_meta")
previous_conclusion=$(jq -r '.conclusion // "unknown"' <<< "$previous_meta")
if [ -z "$previous" ]; then exit 0; fi
if ! jobs=$(timeout 45s gh api "repos/$GITHUB_REPOSITORY/actions/runs/$previous/jobs"); then
  echo "Unable to inspect jobs for prior publisher run $previous within 45 seconds; retrying later." >&2
  exit 1
fi
save_result=$(jq -r '[.jobs[].steps[]? | select(.name == "Save publication log") | .conclusion][0] // "missing"' <<< "$jobs")
publish_result=$(jq -r '[.jobs[].steps[]? | select(.name == "Publish queued post to Instagram and Threads") | .conclusion][0] // "skipped"' <<< "$jobs")
if [[ "$publish_result" == "success" && "$save_result" != "success" && "$previous_conclusion" != "cancelled" && "$previous_conclusion" != "timed_out" ]]; then
  mkdir -p logs
  jq -n --arg run "$previous" --arg state "$save_result" --arg publish "$publish_result" '{run_id:$run,save_result:$state,publish_result:$publish,reason:"Prior publication state was not saved; recover its artifact and reconcile media IDs before resuming"}' > "$hold"
  echo "::error::Prior run $previous did not save publication state. Recovery required; publishing held to prevent duplicates."
  exit 1
fi
