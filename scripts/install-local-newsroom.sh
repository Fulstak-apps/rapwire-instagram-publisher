#!/bin/zsh
set -euo pipefail

# The old newsroom service duplicated the video collector and raced its
# browser profile and Git state. Keep this command as a compatibility shim,
# but install only the single supported repost monitor.
ROOT="${0:A:h}"
exec "$ROOT/install-repost-monitor.sh"
