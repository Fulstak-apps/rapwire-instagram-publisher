#!/usr/bin/env python3
"""Bound one collector pass so a browser hang can never retain its lock."""
import os
import json
import signal
import subprocess
import sys
from pathlib import Path

# A full authenticated Reel download plus H.264 render can exceed four minutes
# on a large source.  Ten minutes prevents the watchdog from killing valid
# work mid-render; stale-lock cleanup still protects the next scheduled pass.
LIMIT_SECONDS = 600

process = subprocess.Popen(
    ["npm", "run", "repost:monitor"],
    start_new_session=True,
)
try:
    process.wait(timeout=LIMIT_SECONDS)
    raise SystemExit(process.returncode)
except subprocess.TimeoutExpired:
    # Signal the entire npm/node/browser-capture process group.  The monitor's
    # finally block removes its lock on a normal termination; a subsequent
    # run also recognizes a stale lock if a browser ignores the first signal.
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    # The child can be killed before its JavaScript finally block runs.  A
    # stale lock must never turn every later scheduled pass into a no-op.
    lock = Path('monitor/repost-monitor.lock')
    try:
        pid = int(json.loads(lock.read_text()).get('pid', 0))
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            lock.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    print(f"RapWire collector exceeded {LIMIT_SECONDS}s and was restarted.", file=sys.stderr)
    raise SystemExit(124)
