#!/usr/bin/env python3
"""Dispatch one publisher run without allowing a network hang to stop launchd."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

REPO = "Fulstak-apps/rapwire-instagram-publisher"
WORKFLOW = "publish-instagram.yml"
GH = "/opt/homebrew/bin/gh"
ACTIVE = {"in_progress", "queued", "pending", "waiting", "requested"}


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [GH, *args],
        text=True,
        capture_output=True,
        timeout=45,
        check=True,
        env={**os.environ, "GH_PAGER": "cat"},
    )


def main() -> int:
    print(f"{stamp()} scheduler check", flush=True)
    try:
        listed = run(
            "run",
            "list",
            "--repo",
            REPO,
            "--workflow",
            WORKFLOW,
            "--limit",
            "20",
            "--json",
            "status",
        )
        runs = json.loads(listed.stdout or "[]")
        if any(str(row.get("status", "")).lower() in ACTIVE for row in runs):
            print(f"{stamp()} skipped: workflow already running", flush=True)
            return 0
        dispatched = run("workflow", "run", WORKFLOW, "--repo", REPO, "--ref", "main")
        url = (dispatched.stdout or "").strip()
        print(f"{stamp()} dispatched: {url}", flush=True)
        return 0
    except subprocess.TimeoutExpired:
        print(f"{stamp()} dispatcher timeout; launchd will retry next cycle", file=sys.stderr)
        return 1
    except (subprocess.CalledProcessError, OSError, ValueError, json.JSONDecodeError) as error:
        detail = getattr(error, "stderr", "") or str(error)
        print(f"{stamp()} dispatcher error; launchd will retry next cycle: {detail.strip()[:500]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
