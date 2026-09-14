#!/usr/bin/env python3
"""Bound one collector pass so a browser hang can never retain its lock."""
import os
import json
import signal
import subprocess
import sys
from pathlib import Path

# The local scheduler runs every five minutes. Leave a small handoff buffer,
# but allow the rotated four-source pass to finish before watchdog recovery.
LIMIT_SECONDS = 290

def terminate_orphaned_rapwire_browser():
    """A killed Playwright parent can leave its dedicated Chrome profile alive.

    Scope this strictly to the RapWire automation profile; never touch the
    user's ordinary Chrome windows. A surviving profile owner otherwise turns
    every following collector pass into a ProcessSingleton failure.
    """
    marker = "user-data-dir=/Users/dw/Library/Application Support/RapWire/InstagramMirrorProfile"
    try:
        output = subprocess.check_output(["pgrep", "-f", marker], text=True, stderr=subprocess.DEVNULL)
        pids = [int(value) for value in output.split() if value.isdigit() and int(value) != os.getpid()]
    except subprocess.CalledProcessError:
        return
    for pid in pids:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    if pids:
        import time
        time.sleep(3)
        for pid in pids:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass

def clear_stale_monitor_lock():
    """Remove only a monitor lock whose recorded process is definitely dead."""
    lock = Path('monitor/repost-monitor.lock')
    try:
        pid = int(json.loads(lock.read_text()).get('pid', 0))
        if pid > 1:
            try:
                os.kill(pid, 0)
                return
            except ProcessLookupError:
                lock.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        # An unreadable lock cannot safely block the entire collector forever.
        # It contains no trustworthy live PID, so only remove this exact lock.
        lock.unlink(missing_ok=True)

clear_stale_monitor_lock()

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
    terminate_orphaned_rapwire_browser()
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
