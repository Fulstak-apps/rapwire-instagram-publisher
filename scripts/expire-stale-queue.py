#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MAX_AGE_HOURS = 48
EVERGREEN_MARKERS = ("meme", "memes", "throwback", "from the vault", "on this day", "years ago", "year ago", "classic", "archive")
now = datetime.now(timezone.utc)
changed = 0


def parse_source_date(source_date):
    if not source_date:
        return None
    # Narro RSS commonly supplies RFC 2822 dates such as:
    # Sat, 29 Aug 2026 19:15:00 GMT
    try:
        parsed = parsedate_to_datetime(source_date)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        pass

    try:
        raw = source_date.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        pass

    try:
        parsed = datetime.fromisoformat(f"{source_date}T00:00:00+00:00")
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


for path in QUEUE.glob("*.json"):
    try:
        item = json.loads(path.read_text())
    except Exception:
        continue
    if item.get("status") != "ready":
        continue
    # Legacy collector records labelled every repost a "throwback", which
    # unintentionally bypassed freshness enforcement.  Preserve only items
    # explicitly identified as an evergreen meme/archive; all other reposts
    # are current news and must carry a recent source timestamp.
    body = " ".join(str(item.get(key, "")) for key in ("headline", "body", "source_caption_text")).lower()
    evergreen = item.get("story_type") == "evergreen_meme" and any(marker in body for marker in EVERGREEN_MARKERS)
    if evergreen:
        continue

    source_date = item.get("source_published_at") or item.get("source_post_date")
    published = parse_source_date(source_date)
    if not published:
        # Instagram does not expose a machine-readable publication time for
        # every authenticated Reel. A just-discovered, fully captured video is
        # safe for one short delivery window; older timestamp-less VIP backlog
        # remains paused rather than being mistaken for breaking news.
        discovered = parse_source_date(item.get("source_discovered_at"))
        if discovered and item.get("media_capture_evidence") and (now - discovered).total_seconds() <= 2 * 3600:
            continue
        item["status"] = "paused"
        item["stale_reason"] = "Unparseable source publication date; held to prevent stale news from publishing."
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
