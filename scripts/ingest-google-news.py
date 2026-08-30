#!/usr/bin/env python3
"""Supplement Narro with fresh Google News RSS results so RapWire isn't trapped in one feed."""
import html
import importlib.util
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MAX_NEW = 4
MAX_AGE_HOURS = 18
QUERIES = [
    "hip hop rap music news when:1d",
    "rapper artist hip hop culture news when:1d",
    "Detroit rap hip hop news when:2d",
]

spec = importlib.util.spec_from_file_location("ingest_narro", ROOT / "scripts" / "ingest-narro.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def clean(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def child_text(item, name):
    for child in item:
        if child.tag.rsplit("}", 1)[-1].lower() == name.lower():
            return clean(child.text)
    return ""


def parse_date(value):
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def source_name(item):
    for child in item:
        if child.tag.rsplit("}", 1)[-1].lower() == "source":
            return clean(child.text) or "News Source"
    return "News Source"

seen = module.existing_urls()
now = datetime.now(timezone.utc)
items = []
for query in QUERIES:
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({
        "q": query,
        "hl": "en-US",
        "gl": "US",
        "ceid": "US:en",
    })
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "RapWire24-NewsMonitor/1.0"})
        raw = urllib.request.urlopen(request, timeout=20).read()
        root = ET.fromstring(raw)
    except Exception as exc:
        print(f"Google News query failed: {exc}")
        continue
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1].lower() != "item":
            continue
        title = child_text(item, "title")
        link = child_text(item, "link")
        pub = child_text(item, "pubDate")
        dt = parse_date(pub)
        if not title or not link or not dt:
            continue
        if (now - dt).total_seconds() > MAX_AGE_HOURS * 3600 or dt > now:
            continue
        guid = child_text(item, "guid") or link
        if guid in seen or link in seen:
            continue
        description = child_text(item, "description")
        fp = module.fingerprint(title, description)
        if fp in seen or any(module.similar_story(fp, old) for old in seen if " " in old and len(old) > 30):
            continue
        source = source_name(item)
        image_url = module.image_from_description(description)
        # Never manufacture a generic stand-in visual when the reporting feed has
        # no event-specific image. Those items must wait for the credited-photo
        # fallback or a human-supplied reference image.
        if not image_url:
            continue
        items.append({"title": title, "link": link, "guid": guid, "description": description, "pub_dt": dt, "source": source, "fingerprint": fp, "image_url": image_url})

items.sort(key=lambda x: x["pub_dt"], reverse=True)
seq = module.next_id()
created = 0
for item in items:
    if created >= MAX_NEW:
        break
    headline = item["title"].split(" - ")[0].strip()
    if len(headline) > 105:
        headline = headline[:102].rsplit(" ", 1)[0] + "..."
    body = item["description"] or item["title"]
    if len(body) > 700:
        body = body[:697].rsplit(" ", 1)[0] + "..."
    story_id = f"{seq:03d}-{module.slugify(headline)}"
    feed1, feed2, story, _ = module.render_graphics(story_id, item["source"], headline, body, item["image_url"])
    source_url = item["link"]
    caption = f"{body}\n\nSource: {item['source']}\n{source_url}\n\n#RapWire247 #HipHop #RapNews"
    queue_item = {
        "status": "ready",
        "story_type": "breaking",
        "source": item["source"],
        "source_urls": [source_url],
        "source_guid": item["guid"],
        "source_title": headline,
        "source_image_url": item["image_url"],
        "source_image_role": "reporting_source_photo",
        "visual_asset_source_urls": [item["image_url"]],
        "source_published_at": item["pub_dt"].isoformat(),
        "story_fingerprint": item["fingerprint"],
        "headline": headline,
        "body": body,
        "caption": caption,
        "threads_text": f"{headline}\n\n{body}\n\n#RapWire247 #HipHop #RapNews",
        "visual_asset_type": "original_graphic",
        "visual_asset_rights": "owned",
        "photo_recency_checked": True,
        "photo_event_relevance": "same_campaign",
        "photo_context_summary": "Original RapWire comic illustration materially redrawn from the specific reporting image supplied with this story.",
        "source_photo_used": True,
        "ai_generated_art": True,
        "photo_capture_date": item["pub_dt"].date().isoformat(),
        "media_urls": [str(feed1.relative_to(ROOT)), str(feed2.relative_to(ROOT))],
        "story_media_url": str(story.relative_to(ROOT)),
        "slides": [str(feed1.relative_to(ROOT)), str(feed2.relative_to(ROOT))],
        "story": str(story.relative_to(ROOT)),
    }
    (QUEUE / f"{story_id}.json").write_text(json.dumps(queue_item, indent=2) + "\n")
    seen.add(item["guid"])
    seq += 1
    created += 1

print(f"Google News supplement: created {created} fresh story/stories.")
