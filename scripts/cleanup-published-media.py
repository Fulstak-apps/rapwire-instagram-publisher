#!/usr/bin/env python3
"""Remove repository media only after both feed publications are confirmed."""
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"

paths = set()
for queue_file in QUEUE.glob("*.json"):
    try:
        item = json.loads(queue_file.read_text())
    except (OSError, json.JSONDecodeError):
        continue
    if not (item.get("status") == "published"
            and item.get("instagram_media_id")
            and item.get("threads_media_id")):
        continue
    for field in ("video", "story_video", "story"):
        value = item.get(field)
        if not isinstance(value, str) or not value.startswith("media/"):
            continue
        path = pathlib.PurePosixPath(value)
        if path.parts[0] == "media" and len(path.parts) == 2:
            paths.add(path.as_posix())

if not paths:
    print("Published media cleanup: no confirmed media to remove.")
    raise SystemExit(0)

result = subprocess.run(
    ["git", "rm", "--cached", "--ignore-unmatch", "--", *sorted(paths)],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
if result.returncode != 0:
    raise SystemExit(result.stderr.strip() or "git rm failed")

# Remove materialized copies too; sparse checkouts normally have none.
removed = 0
for value in paths:
    path = ROOT / value
    if path.is_file():
        path.unlink()
        removed += 1
print(f"Published media cleanup: untracked {len(paths)} confirmed asset(s); removed {removed} local file(s).")
