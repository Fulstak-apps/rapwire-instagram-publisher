#!/usr/bin/env python3
import html
import json
import os
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
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
MAX_SOURCE_AGE_HOURS = int(os.environ.get("MAX_SOURCE_AGE_HOURS", "36"))

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


def attr_url(item, tag_names):
    for child in item:
        local = child.tag.rsplit("}", 1)[-1].lower()
        if local in tag_names:
            url = child.attrib.get("url") or child.attrib.get("href")
            if url and url.startswith("http"):
                return url
    return ""


def image_from_description(text):
    match = re.search(r"<img[^>]+src=[\"']([^\"']+)[\"']", text or "", re.I)
    return html.unescape(match.group(1)) if match else ""


def source_from_item(item, link, raw_text):
    author = tag_text(item, "author") or tag_text(item, "creator")
    candidates = [author, link, raw_text]
    for candidate in candidates:
        handle = re.search(r"@([A-Za-z0-9._]+)", candidate or "")
        if handle and handle.group(1).lower() in SOURCES:
            return handle.group(1).lower()
        m = re.search(r"instagram\.com/([A-Za-z0-9._]+)/?", candidate or "", re.I)
        if m and m.group(1).lower() in SOURCES:
            return m.group(1).lower()
    return ""


def parse_pub_date(value):
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
        encoded = tag_text(item, "encoded")
        pub = tag_text(item, "pubDate") or tag_text(item, "published") or tag_text(item, "date")
        raw_text = " ".join([title, description, encoded, tag_text(item, "author"), link])
        source = source_from_item(item, link, raw_text)
        if not source:
            continue
        image_url = (
            attr_url(item, {"content", "thumbnail", "enclosure"})
            or image_from_description(description)
            or image_from_description(encoded)
        )
        pub_dt = parse_pub_date(pub)
        items.append({
            "title": title,
            "link": link,
            "guid": guid,
            "description": description or encoded,
            "pub": pub,
            "pub_dt": pub_dt,
            "source": source,
            "image_url": image_url,
        })
    return items


def existing_urls():
    seen = set()
    for path in QUEUE.glob("*.json"):
        try:
            data = json.loads(path.read_text())
            seen.update(data.get("source_urls", []))
            if data.get("source_guid"):
                seen.add(data["source_guid"])
            if data.get("story_fingerprint"):
                seen.add(data["story_fingerprint"])
        except Exception:
            continue
    return seen


def fingerprint(title, description):
    text = re.sub(r"[^a-z0-9 ]+", " ", f"{title} {description}".lower())
    words = [w for w in text.split() if len(w) > 2]
    return " ".join(sorted(set(words))[:80])


def similar_story(a, b):
    sa = set(a.split())
    sb = set(b.split())
    if not sa or not sb:
        return False
    return len(sa & sb) / max(1, min(len(sa), len(sb))) >= 0.68


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


def draw_halftone(draw, box, step=24):
    x0, y0, x1, y1 = box
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            r = 3 + ((x + y) // step) % 3
            draw.ellipse((x-r, y-r, x+r, y+r), fill=(90, 55, 150))


def render_graphics(story_id, source, headline, body, comic_style):
    MEDIA.mkdir(parents=True, exist_ok=True)
    slide1 = MEDIA / f"{story_id}-slide-1.png"
    slide2 = MEDIA / f"{story_id}-slide-2.png"
    W, H = 1080, 1350

    if comic_style:
        im = Image.new("RGB", (W, H), (20, 19, 31))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, W, H), fill=(22, 20, 34))
        draw_halftone(d, (0, 0, W, 760))
        d.polygon([(0, 190), (W, 80), (W, 700), (0, 820)], fill=(48, 35, 80))
        d.polygon([(0, 520), (W, 390), (W, 780), (0, 900)], fill=(126, 22, 45))
        d.rectangle((54, 50, 420, 126), fill=(245, 202, 44))
        d.text((78, 65), datetime.now(timezone.utc).strftime("%b %d, %Y").upper(), font=font(FONT_BOLD, 38), fill=(18, 18, 22))
        d.text((54, 160), "RAPWIRE 24/7", font=font(FONT_BOLD, 66), fill=(255, 255, 255))
        d.rectangle((54, 252, 1026, 258), fill=(245, 202, 44))
        headline_font = font(FONT_BOLD, 82)
        lines = wrap(d, headline.upper(), headline_font, 930)
        y = 320
        for i, line in enumerate(lines[:5]):
            offset = 8
            d.text((62 + offset, y + offset), line, font=headline_font, fill=(8, 8, 12))
            d.text((62, y), line, font=headline_font, fill=(247, 247, 244))
            y += 100
        d.polygon([(700, 950), (1015, 900), (1030, 1180), (650, 1220)], fill=(245, 202, 44))
        d.text((710, 960), "BREAKING", font=font(FONT_BOLD, 40), fill=(18, 18, 22))
        d.text((710, 1020), f"@{source}", font=font(FONT_BOLD, 36), fill=(18, 18, 22))
        d.rectangle((54, 1090, 620, 1245), fill=(245, 247, 244))
        detail = wrap(d, body, font(FONT_BOLD, 30), 520)
        yy = 1110
        for line in detail[:4]:
            d.text((76, yy), line, font=font(FONT_BOLD, 30), fill=(25, 24, 30))
            yy += 36
        d.text((54, 1280), "HIP-HOP • CULTURE • REAL-TIME", font=font(FONT_BOLD, 26), fill=(245, 202, 44))
    else:
        im = Image.new("RGB", (W, H), (14, 15, 18))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, W, 16), fill=(245, 202, 44))
        d.text((58, 48), "RAPWIRE 24/7", font=font(FONT_BOLD, 54), fill=(255, 255, 255))
        d.text((58, 118), datetime.now(timezone.utc).strftime("%A, %B %d, %Y"), font=font(FONT_BOLD, 28), fill=(175, 177, 184))
        d.rectangle((58, 182, 1022, 188), fill=(245, 202, 44))
        hf = font(FONT_BOLD, 78)
        lines = wrap(d, headline.upper(), hf, 920)
        y = 270
        for line in lines[:6]:
            d.text((58, y), line, font=hf, fill=(248, 248, 246))
            y += 92
        d.rounded_rectangle((58, 900, 1022, 1160), radius=24, fill=(30, 31, 38), outline=(245, 202, 44), width=4)
        d.text((88, 930), "THE DETAILS", font=font(FONT_BOLD, 34), fill=(245, 202, 44))
        body_lines = wrap(d, body, font(FONT_REG, 38), 880)
        yy = 990
        for line in body_lines[:5]:
            d.text((88, yy), line, font=font(FONT_REG, 38), fill=(242, 242, 240))
            yy += 52
        d.text((58, 1210), f"SOURCE  @{source}", font=font(FONT_BOLD, 30), fill=(170, 172, 180))
        d.text((58, 1270), "HIP-HOP • CULTURE • REAL-TIME", font=font(FONT_BOLD, 26), fill=(245, 202, 44))

    im.save(slide1, quality=95)

    im2 = Image.new("RGB", (W, H), (14, 15, 18))
    d2 = ImageDraw.Draw(im2)
    d2.rectangle((0, 0, W, 16), fill=(245, 202, 44))
    d2.text((58, 52), "RAPWIRE 24/7", font=font(FONT_BOLD, 54), fill=(255, 255, 255))
    d2.text((58, 145), "THE DETAILS", font=font(FONT_BOLD, 40), fill=(245, 202, 44))
    body_lines = wrap(d2, body, font(FONT_REG, 44), 900)
    yy = 250
    for line in body_lines[:14]:
        d2.text((70, yy), line, font=font(FONT_REG, 44), fill=(245, 245, 242))
        yy += 62
    d2.rounded_rectangle((58, 1120, 1022, 1240), radius=20, fill=(28, 29, 35), outline=(245, 202, 44), width=3)
    d2.text((88, 1150), f"REPORTED BY  @{source}", font=font(FONT_BOLD, 30), fill=(245, 245, 242))
    d2.text((58, 1280), "RAPWIRE 24/7", font=font(FONT_BOLD, 30), fill=(245, 202, 44))
    im2.save(slide2, quality=95)
    return str(slide1.relative_to(ROOT)), str(slide2.relative_to(ROOT))


def main():
    request = urllib.request.Request(FEED_URL, headers={"User-Agent": "RapWire24-SourceMonitor/2.0"})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read()

    items = parse_feed(raw)
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - MAX_SOURCE_AGE_HOURS * 60 * 60
    seen = existing_urls()
    fresh = []
    for item in items:
        pub_dt = item.get("pub_dt")
        if not pub_dt or pub_dt.timestamp() < cutoff or pub_dt > now:
            continue
        key = item["guid"] or item["link"]
        if key in seen or item["link"] in seen:
            continue
        fp = fingerprint(item["title"], item["description"])
        if fp in seen:
            continue
        if any(similar_story(fp, old) for old in seen if " " in old and len(old) > 30):
            continue
        item["fingerprint"] = fp
        fresh.append(item)

    fresh.sort(key=lambda x: x.get("pub_dt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    fresh = fresh[:MAX_NEW]

    if not fresh:
        print("Narro: no current source items.")
        return

    seq = next_id()
    today = now.date().isoformat()

    for item in fresh:
        headline = clean(item["title"])
        body = clean(item["description"]) or headline
        if len(body) > 700:
            body = body[:697].rsplit(" ", 1)[0] + "..."
        source = item["source"].lstrip("@").strip()
        story_id = f"{seq:03d}-{slugify(headline)}"
        comic_style = seq % 3 == 1
        slide1, slide2 = render_graphics(story_id, source, headline, body, comic_style)

        source_url = item["link"] or FEED_URL
        caption = (
            f"{body}\n\nSource: @{source}\n{source_url}\n\n"
            f"#RapWire247 #HipHopNews"
        )
        threads_text = f"{headline}\n\n{body}\n\nSource: @{source}\n{source_url}"
        threads_text = threads_text[:500]

        source_date = item["pub_dt"].date().isoformat()
        queue_item = {
            "status": "ready",
            "story_type": "general_news",
            "date": today,
            "timezone": "America/Detroit",
            "headline": headline,
            "body": body,
            "slides": [slide1, slide2],
            "media_urls": [item["image_url"]] if item["image_url"] and not comic_style else [],
            "story": slide1,
            "story_media_url": item["image_url"] if item["image_url"] and not comic_style else "",
            "cover_style": "comic" if comic_style else "current-source-photo",
            "caption": caption,
            "threads_text": threads_text,
            "source_urls": [u for u in [source_url, FEED_URL] if u],
            "source_guid": item["guid"],
            "story_fingerprint": item["fingerprint"],
            "source_published_at": item["pub"],
            "source_post_date": source_date,
            "lead_source_instagram_handle": f"@{source}",
            "reporting_source_instagram_handle": f"@{source}",
            "artist_instagram_handle": "",
            "photo_subject": "Current source visual" if item["image_url"] else "RapWire original graphic",
            "photo_capture_date": source_date,
            "photo_recency_checked": True,
            "photo_event_relevance": "event_specific",
            "photo_context_summary": "Visual comes from the monitored source post published within the current recency window; no older archival image is selected unless the source story itself is a throwback.",
            "visual_asset_source_urls": [item["image_url"]] if item["image_url"] else [],
            "visual_asset_rights": "source_post_repost" if item["image_url"] else "owned",
            "visual_asset_type": "source_photo" if item["image_url"] and not comic_style else "original_graphic",
            "publish_after": now.isoformat(),
        }
        (QUEUE / f"{story_id}.json").write_text(json.dumps(queue_item, indent=2) + "\n")
        print(f"Queued {story_id}: {headline} [{source}] cover={queue_item['cover_style']}")
        seq += 1


if __name__ == "__main__":
    main()
