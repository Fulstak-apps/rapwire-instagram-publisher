#!/usr/bin/env python3
"""One bounded local editorial cycle. Never pushes, approves, or publishes drafts."""
import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "review" / "local-editor"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / ".lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        started = datetime.now(timezone.utc).isoformat()
        try:
            result = subprocess.run([sys.executable, str(ROOT / "scripts/local-rapwire.py")],
                cwd=ROOT, env={**os.environ, "RAPWIRE_DRAFT_DIR": str(OUTPUT), "MAX_NEW_ITEMS": "4"},
                capture_output=True, text=True, timeout=600)
            status = {"started_at": started, "exit_code": result.returncode,
                      "stdout": result.stdout, "stderr": result.stderr,
                      "mode": "review_only", "publishing_enabled": False}
        except subprocess.TimeoutExpired:
            status = {"started_at": started, "exit_code": 1, "error": "Editor exceeded ten-minute limit",
                      "mode": "review_only", "publishing_enabled": False}
        status["finished_at"] = datetime.now(timezone.utc).isoformat()
        temporary = OUTPUT / ".health.tmp"
        temporary.write_text(json.dumps(status, indent=2) + "\n")
        temporary.replace(OUTPUT / "health.json")
        print(json.dumps(status, indent=2), flush=True)
        return status["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
