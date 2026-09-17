#!/usr/bin/env python3
"""Remove repository media only after both feed publications are confirmed."""
import json
import pathlib
import shutil
import subprocess
import time

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
    ["git", "rm", "--cached", "--sparse", "--ignore-unmatch", "--", *sorted(paths)],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
if result.returncode != 0:
    raise SystemExit(result.stderr.strip() or "git rm failed")

# Move materialized copies to the user's macOS Trash when available. The
# GitHub runner has no user Trash, so it simply has no local copy to move.
trash = pathlib.Path.home() / ".Trash"
trash.mkdir(parents=True, exist_ok=True)
removed = 0
trashed = 0
for value in paths:
    path = ROOT / value
    if path.is_file():
        destination = trash / path.name
        if destination.exists():
            destination = trash / f"{path.stem}-{int(time.time())}{path.suffix}"
        try:
            shutil.move(str(path), str(destination))
            trashed += 1
        except OSError:
            path.unlink()
        removed += 1
print(f"Published media cleanup: untracked {len(paths)} confirmed asset(s); moved {trashed} local file(s) to Trash; removed {removed - trashed} fallback file(s).")
