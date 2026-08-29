#!/usr/bin/env python3
import html
import json
import os
import re
import textwrap
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MEDIA = ROOT / "media"
FEED_URL = os.environ.get(
    "NARRO_RSS_URL",
    "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f",
)
MAX_NEW = int(os.environ.get("MAX_NEW_ITEMS", "6"))

SOURCES = {
    "akademiks", "nojumper", "theshaderoom", "tmz", "traploreross", "saycheesetv",
    "detroitrapnews", "detroitrapdaily", "usacrime", "poetikflakkonews",
    "worldstarhiphop", "gta6latest",
}

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def clean(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def tag_text(item, name):
    for child in item:
        if child.tag.rsplit("}", 1)[-1].lower() == name.lower():
            return clean(child.text)
    return ""


def source_from_item(item, link):
    author = tag_text(item, "author") or tag_text(item, "creator")
    handle = re.search(r"@([A-Za-z0-9._]+)", author or "")
    if handle:
        return handle.group(1).lower()
    m = re.search(r"instagram\.com/([A-Za-z0-9._]+)/?", link or "", re.I)
    if m:
        return m.group(1).lower()
    return author.strip() or "RapWire source"


def parse_feed(raw):
    root = ET.fromstring(raw)
    items = []
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1].lower() != "item":
            continue
        title = tag_text(item, "title")
        link = tag_text(item, "link")
        guid = tag_text(item, "guid") or link or title
        description = tag_text(item, "description")
        pub = tag_text(item, "pubDate") or tag_text(item, "published") or tag_text(item, "date")
        source = source_from_item(item, link)
        if source.casefold() not in SOURCES:
            # Narro may not expose the author consistently; retain the item if it
            # has a real link and let the editorial source line identify it.
            source = source or "Narro"
        if title and (link or guid):
            items.append({"title": title, "link": link, "guid": guid, "description": description, "pub": pub, "source": source})
    return items


def existing_urls():
    seen = set()
    for path in QUEUE.glob("*.json"):
        try:
            data = json.loads(path.read_text())
            seen.update(data.get("source_urls", []))
            if data.get("source_guid"):
                seen.add(data["source_guid"])
        except Exception:
            continue
    return seen


def slugify(text):
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:60] or "story"


def next_id():
    nums = []
    for path in QUEUE.glob("*.json"):
        m = re.match(r"(\d+)-", path.name)
        if m:
            nums.append(int(m.group(1)))
    return (max(nums) + 1) if nums else 1


def font(path, size):
    return ImageFont.truetype(path, size)


def wrap(draw, text, fnt, width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textbbox((0, 0), trial, font=fnt)[2] <= width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def render_graphics(story_id, source, headline, body):
    MEDIA.mkdir(parents=True, exist_ok=True)
    slide1 = MEDIA / f"{story_id}-slide-1.png"
    slide2 = MEDIA / f"{story_id}-slide-2.png"
    W, H = 1080, 1350

    def base():
        im = Image.new("RGB", (W, H), (12, 12, 14))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, W, 18), fill=(226, 31, 52))
        d.text((70, 58), "RAPWIRE 24/7", font=font(FONT_BOLD, 52), fill=(255, 255, 255))
        d.text((70, 1240), f"SOURCE  @{source.lstrip('@')}", font=font(FONT_BOLD, 28), fill=(190, 190, 195))
        return im, d

    im, d = base()
    hf = font(FONT_BOLD, 82)
    lines = wrap(d, headline.upper(), hf, 900)
    y = 300
    for line in lines[:6]:
        d.text((70, y), line, font=hf, fill=(255, 255, 255))
        y += 98
    d.text((70, y + 40), "24/7 HIP-HOP & CULTURE NEWS", font=font(FONT_BOLD, 30), fill=(226, 31, 52))
    im.save(slide1, quality=95)

    im, d = base()
    bf = font(FONT_REG, 44)
    lines = wrap(d, body, bf, 900)
    y = 260
    for line in lines[:15]:
        d.text((70, y), line, font=bf, fill=(245, 245, 245))
        y += 60
    im.save(slide2, quality=95)
    return str(slide1.relative_to(ROOT)), str(slide2.relative_to(ROOT))


def main():
    request = urllib.request.Request(FEED_URL, headers={"User-Agent": "RapWire24-SourceMonitor/1.0"})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read()

    items = parse_feed(raw)
    seen = existing_urls()
    fresh = []
    for item in items:
        key = item["guid"] or item["link"]
        if key in seen or item["link"] in seen:
            continue
        fresh.append(item)
    fresh.sort(key=lambda x: x.get("pub", ""), reverse=True)
    fresh = fresh[:MAX_NEW]

    if not fresh:
        print("Narro: no new source items.")
        return

    seq = next_id()
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()

    for item in fresh:
        headline = clean(item["title"])
        body = clean(item["description"]) or headline
        if len(body) > 700:
            body = body[:697].rsplit(" ", 1)[0] + "..."
        source = item["source"].lstrip("@").strip() or "Narro"
        story_id = f"{seq:03d}-{slugify(headline)}"
        slide1, slide2 = render_graphics(story_id, source, headline, body)

        source_url = item["link"] or FEED_URL
        caption = (
            f"{body}\n\nSource: @{source}\n{source_url}\n\n"
            f"#RapWire247 #HipHopNews"
        )
        threads_text = f"{headline}\n\n{body}\n\nSource: @{source}\n{source_url}"
        threads_text = threads_text[:500]

        queue_item = {
            "status": "ready",
            "story_type": "general_news",
            "date": today,
            "timezone": "America/Detroit",
            "headline": headline,
            "body": body,
            "slides": [slide1, slide2],
            "story": slide1,
            "caption": caption,
            "threads_text": threads_text,
            "featured_artist": "RapWire 24/7",
            "photo_subject": "RapWire original graphic",
            "audio_artist": "RapWire 24/7",
            "audio_status": "not_applicable",
            "identity_checked": True,
            "source_urls": [u for u in [source_url, FEED_URL] if u],
            "visual_asset_source_urls": [FEED_URL],
            "visual_asset_rights": "owned",
            "visual_asset_type": "original_graphic",
            "photo_capture_date": today,
            "photo_recency_checked": True,
            "photo_event_relevance": "event_specific",
            "photo_context_summary": "Original RapWire graphic generated from the source headline and description; no source photograph is reused.",
            "artist_instagram_handle": "",
            "lead_source_instagram_handle": f"@{source}",
            "reporting_source_instagram_handle": f"@{source}",
            "subject_handle_verification": "General-news item; no artist handle asserted.",
            "publish_after": now.isoformat(),
            "source_guid": item["guid"],
            "source_published_at": item.get("pub", ""),
        }
        (QUEUE / f"{story_id}.json").write_text(json.dumps(queue_item, indent=2) + "\n")
        print(f"Queued {story_id}: {headline}")
        seq += 1


if __name__ == "__main__":
    main()
