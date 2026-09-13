#!/usr/bin/env python3
"""Run exactly one RapWire local cycle at a time using an OS-held lock."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "monitor" / "newsroom.flock"
LOCK.parent.mkdir(parents=True, exist_ok=True)

with LOCK.open("w") as handle:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("RapWire worker already running; skipping overlapping launchd cycle.", file=sys.stderr)
        raise SystemExit(0)
    environment = os.environ.copy()
    environment["RAPWIRE_WORKER_LOCK_HELD"] = "1"
    raise SystemExit(subprocess.run([sys.argv[1], *sys.argv[2:]], cwd=ROOT, env=environment).returncode)
