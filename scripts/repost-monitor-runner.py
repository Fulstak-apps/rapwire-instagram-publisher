#!/usr/bin/env python3
"""Bound one collector pass so a browser hang can never retain its lock."""
import os
import signal
import subprocess
import sys

LIMIT_SECONDS = 240

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
    print(f"RapWire collector exceeded {LIMIT_SECONDS}s and was restarted.", file=sys.stderr)
    raise SystemExit(124)
