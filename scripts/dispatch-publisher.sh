#!/bin/zsh
set -euo pipefail

# Keep dispatch logic versioned with the publisher. The Python wrapper adds
# hard network timeouts because a hung `gh` request otherwise leaves launchd's
# scheduler occupied until the next reboot.
ROOT="${0:A:h}"
exec /opt/homebrew/bin/python3 "$ROOT/dispatch-publisher.py"
