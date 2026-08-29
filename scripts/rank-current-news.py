#!/usr/bin/env python3
"""Keep RapWire focused on genuinely relevant, current hip-hop/culture stories."""
import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MAX_AGE_HOURS = 18

POSITIVE = {
    "hip hop", "hip-hop", "rap", "rapper", "rappers", "artist", "album", "single", "song",
    "mixtape", "tour", "concert", "producer", "dj", "record label", "label", "music",
    "beef", "diss", "diss track", "freestyle", "verse", "feature", "vma", "grammy",
    "billboard", "viral", "culture", "streetwear", "sneaker", "boxing", "podcast",
    "film", "movie", "tv", "show", "detroit", "atlanta", "memphis", "compton", "chicago",
    "new york", "los angeles", "brooklyn", "rapper", "hiphop",
}
NEGATIVE = {
    "weather", "forecast", "stock market", "mortgage", "real estate", "crypto price",
    "election", "senate", "congress", "president", "tax", "grocery", "recipe",
    "traffic", "school board", "baseball", "hockey", "soccer", "tennis",
}


def parse_date(value):
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except Exception:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def relevance(item):
    text = f"{item.get('headline','')} {item.get('body','')} {item.get('source_title','')}".lower()
    score = sum(2 for term in POSITIVE if term in text)
    score -= sum(4 for term in NEGATIVE if term in text)
    source = item.get("source", "").lower()
    if source in {"akademiks", "nojumper", "theshaderoom", "traploreross", "saycheesetv", "detroitrapnews", "detroitrapdaily", "worldstarhiphop"}:
        score += 5
    return score

now = datetime.now(timezone.utc)
paused = 0
kept = 0
for path in QUEUE.glob("*.json"):
    try:
        item = json.loads(path.read_text())
    except Exception:
        continue
    if item.get("status") != "ready" or item.get("story_type") == "throwback":
        continue
    published = parse_date(item.get("source_published_at") or item.get("source_post_date"))
    age = ((now - published).total_seconds() / 3600) if published else 999
    score = relevance(item)
    item["relevance_score"] = score
    if age > MAX_AGE_HOURS or age < -1 or score < 2:
        item["status"] = "paused"
        item["stale_reason"] = "Outside RapWire current-news relevance window." if age > MAX_AGE_HOURS else "Low RapWire hip-hop/culture relevance score."
        path.write_text(json.dumps(item, indent=2) + "\n")
        paused += 1
    else:
        path.write_text(json.dumps(item, indent=2) + "\n")
        kept += 1

print(f"News ranking: kept {kept}, paused {paused} low-relevance/stale story/stories.")
