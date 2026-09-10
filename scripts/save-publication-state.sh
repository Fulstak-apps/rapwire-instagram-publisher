#!/usr/bin/env bash
set -euo pipefail
if [ -z "$(git status --porcelain -- queue logs)" ]; then exit 0; fi
git config user.name "RapWire 24/7"
git config user.email "actions@users.noreply.github.com"
git add -- queue logs
git commit -m "Log RapWire publication"
for attempt in 1 2 3; do
  # A transient GitHub/network failure must not trigger the safety hold that
  # pauses all later publishing.  Keep conflicts fail-safe, but actually use
  # all retries instead of exiting immediately because `set -e` saw pull fail.
  if git pull --rebase origin main && git push origin HEAD:main; then exit 0; fi
  git rebase --abort >/dev/null 2>&1 || true
  sleep "$((attempt * 5))"
done
echo "Publication state push failed. Recover the publication-state artifact before publishing again." >&2
exit 1
