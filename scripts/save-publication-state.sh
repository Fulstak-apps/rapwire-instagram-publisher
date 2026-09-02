#!/usr/bin/env bash
set -euo pipefail
if [ -z "$(git status --porcelain -- queue logs)" ]; then exit 0; fi
git config user.name "RapWire 24/7"
git config user.email "actions@users.noreply.github.com"
git add -- queue logs
git commit -m "Log RapWire publication"
for attempt in 1 2 3; do
  git pull --rebase origin main
  if git push origin HEAD:main; then exit 0; fi
  sleep 5
done
echo "Publication state push failed. Recover the publication-state artifact before publishing again." >&2
exit 1
