#!/usr/bin/env python3
"""Remove repository media only after both feed publications are confirmed."""
import json
import pathlib
import re
import shutil
import subprocess
import time
import uuid
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"

paths = set()
published_shortcodes = set()
protected_paths = set()
protected_shortcodes = set()
for queue_file in QUEUE.glob("*.json"):
    try:
        item = json.loads(queue_file.read_text())
    except (OSError, json.JSONDecodeError):
        raise SystemExit(f"Cleanup stopped: unreadable queue record {queue_file.name}")
    if not (item.get("status") == "published"
            and item.get("instagram_media_id")
            and item.get("threads_media_id")):
        protected_paths.update(item.get(field) for field in ("video", "story_video", "story") if isinstance(item.get(field), str))
        pending_match = re.search(r"/(?:reel|p)/([A-Za-z0-9_-]+)", str(item.get("source_url", "")))
        if pending_match:
            protected_shortcodes.add(pending_match.group(1))
        continue
    match = re.search(r"/(?:reel|p)/([A-Za-z0-9_-]+)", str(item.get("source_url", "")))
    if match:
        published_shortcodes.add(match.group(1))
    for field in ("video", "story_video", "story"):
        value = item.get(field)
        if not isinstance(value, str) or not value.startswith("media/"):
            continue
        path = pathlib.PurePosixPath(value)
        if path.parts[0] == "media" and len(path.parts) == 2:
            paths.add(path.as_posix())

paths -= protected_paths
published_shortcodes -= protected_shortcodes
if not paths:
    print("Published media cleanup: no confirmed media to remove.")
    raise SystemExit(0)

if "--local-only" not in sys.argv:
    result = subprocess.run(
        ["git", "rm", "--cached", "--sparse", "--ignore-unmatch", "--", *sorted(paths)],
        cwd=ROOT, text=True, capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "git rm failed")

# Include local capture/render sidecars for already-published source posts.
mirror_dir = ROOT / "work" / "instagram-mirror"
if mirror_dir.is_dir():
    for candidate in mirror_dir.iterdir():
        if any(candidate.name == code or candidate.name.startswith(f"{code}-") or candidate.name.startswith(f"{code}.") for code in published_shortcodes):
            paths.add(str(candidate.relative_to(ROOT)))

# Remove materialized copies only after both feed publications have durable IDs.
# ``--purge`` reclaims disk immediately; the default keeps the previous
# recoverable macOS Trash behaviour for an operator-initiated review run.
purge = "--purge" in sys.argv
trash = pathlib.Path.home() / ".Trash"
if not purge:
    trash.mkdir(parents=True, exist_ok=True)
removed = 0
trashed = 0
for value in paths:
    path = ROOT / value
    if "--local-only" in sys.argv and value.startswith("media/"):
        # Do not dirty the working tree; cloud cleanup first untracks the file.
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", "--", value], cwd=ROOT, capture_output=True)
        if tracked.returncode == 0:
            continue
    if path.exists():
        try:
            if purge:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            else:
                destination = trash / path.name
                if destination.exists():
                    destination = trash / f"{path.stem}-{uuid.uuid4().hex}{path.suffix}"
                shutil.move(str(path), str(destination))
            trashed += 1
        except OSError as error:
            print(f"Trash failed; keeping {path}: {error}")
            continue
        removed += 1
action = "permanently deleted" if purge else "moved to Trash"
print(f"Published media cleanup: {action} {trashed} confirmed local file(s).")
