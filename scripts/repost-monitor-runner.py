#!/usr/bin/env python3
"""Bound one collector pass so a browser hang can never retain its lock."""
import os
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

# The local scheduler runs every five minutes, but a valid long Reel can take
# nearly five minutes to discover, download, inspect, render, and push when the
# CPU is also serving another publisher. 290 seconds killed that successful
# capture between rendering and committing it, so the remote queue stayed empty.
# The monitor's own lock makes overlapping five-minute ticks exit safely; give
# one pass enough time to finish while still bounding a genuinely stuck browser.
LIMIT_SECONDS = 570
GIT_TEMP_MAX_AGE_SECONDS = 15 * 60

def cleanup_stale_git_temporary_objects():
    """Remove only abandoned objects left by an interrupted `git fetch`.

    A killed fetch can leave a tmp_pack file almost as large as the repository.
    The next video transcode then fails with ENOSPC even though the queue and
    browser are healthy. This runs before the child starts (so no local Git
    command is active) and touches only Git's explicitly temporary pack files.
    """
    pack_dir = Path('.git/objects/pack')
    cutoff = time.time() - GIT_TEMP_MAX_AGE_SECONDS
    for path in pack_dir.glob('tmp_pack_*'):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            # A concurrent fetch or a read-only checkout should not prevent the
            # collector from attempting its normal bounded pass.
            pass

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
    """Remove a dead or orphaned monitor lock, never a live monitor lock.

    PID reuse is possible after a killed Node process.  The old check treated
    any live PID as the collector, so a recycled PID could make every later
    pass report ``locked`` forever.  Verify the command line as well as PID
    liveness before allowing that lock to block the scheduler.
    """
    lock = Path('monitor/repost-monitor.lock')

    def owner_is_monitor(pid):
        try:
            command = subprocess.check_output(
                ["ps", "-p", str(pid), "-o", "command="],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=5,
            ).strip()
        except (OSError, subprocess.SubprocessError):
            return False
        return "repost-monitor-runner.py" in command or "instagram-repost-monitor.mjs" in command

    try:
        pid = int(json.loads(lock.read_text()).get('pid', 0))
        if pid > 1:
            try:
                os.kill(pid, 0)
                if owner_is_monitor(pid):
                    return
            except ProcessLookupError:
                pass
            lock.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        # An unreadable lock cannot safely block the entire collector forever.
        # It contains no trustworthy live PID, so only remove this exact lock.
        lock.unlink(missing_ok=True)

cleanup_stale_git_temporary_objects()
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
            command = subprocess.check_output(
                ["ps", "-p", str(pid), "-o", "command="],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=5,
            ).strip()
            if "repost-monitor-runner.py" not in command and "instagram-repost-monitor.mjs" not in command:
                lock.unlink(missing_ok=True)
        except (ProcessLookupError, OSError, subprocess.SubprocessError):
            lock.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    print(f"RapWire collector exceeded {LIMIT_SECONDS}s and was restarted.", file=sys.stderr)
    raise SystemExit(124)
