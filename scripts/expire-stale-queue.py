#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MAX_AGE_HOURS = 36
now = datetime.now(timezone.utc)
changed = 0

for path in QUEUE.glob("*.json"):
    try:
        item = json.loads(path.read_text())
    except Exception:
        continue
    if item.get("status") != "ready":
        continue
    if item.get("story_type") == "throwback":
        continue
    source_date = item.get("source_published_at") or item.get("source_post_date")
    if not source_date:
        item["status"] = "paused"
        item["stale_reason"] = "No source publication date; held to prevent stale news from publishing."
        path.write_text(json.dumps(item, indent=2) + "\n")
        changed += 1
        continue
    try:
        raw = source_date.replace("Z", "+00:00")
        published = datetime.fromisoformat(raw)
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        published = published.astimezone(timezone.utc)
    except Exception:
        try:
            published = datetime.fromisoformat(f"{source_date}T00:00:00+00:00")
        except Exception:
            item["status"] = "paused"
            item["stale_reason"] = "Unparseable source publication date."
            path.write_text(json.dumps(item, indent=2) + "\n")
            changed += 1
            continue
    age_hours = (now - published).total_seconds() / 3600
    if age_hours > MAX_AGE_HOURS or age_hours < -1:
        item["status"] = "paused"
        item["stale_reason"] = f"Source item outside the {MAX_AGE_HOURS}-hour current-news window."
        path.write_text(json.dumps(item, indent=2) + "\n")
        changed += 1

print(f"Stale queue cleanup: paused {changed} item(s).")
