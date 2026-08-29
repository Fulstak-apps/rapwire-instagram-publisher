#!/usr/bin/env python3
import html
import io
import json
import os
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MEDIA = ROOT / "media"
FEED_URL = os.environ.get("NARRO_RSS_URL", "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f")
MAX_NEW = int(os.environ.get("MAX_NEW_ITEMS", "6"))
MAX_SOURCE_AGE_HOURS = int(os.environ.get("MAX_SOURCE_AGE_HOURS", "36"))

SOURCES = {
    "akademiks", "nojumper", "theshaderoom", "tmz", "traploreross", "saycheesetv",
    "detroitrapnews", "detroitrapdaily", "usacrime", "poetikflakkonews",
    "worldstarhiphop", "gta6latest",
}

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# RapWire's visual system: 1980s newsstand/comic-book energy, but clean enough for Instagram.
INK = (20, 18, 29)
PAPER = (247, 246, 239)
YELLOW = (248, 204, 47)
PURPLE = (69, 40, 102)
RED = (137, 25, 48)
CYAN = (31, 190, 204)


def clean(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


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
    for candidate in (author, link, raw_text):
        handle = re.search(r"@([A-Za-z0-9._]+)", candidate or "")
        if handle and handle.group(1).lower() in SOURCES:
            return handle.group(1).lower()
        match = re.search(r"instagram\.com/([A-Za-z0-9._]+)/?", candidate or "", re.I)
        if match and match.group(1).lower() in SOURCES:
            return match.group(1).lower()
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
        items.append({
            "title": title,
            "link": link,
            "guid": guid,
            "description": description or encoded,
            "pub": pub,
            "pub_dt": parse_pub_date(pub),
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
    sa, sb = set(a.split()), set(b.split())
    return bool(sa and sb) and len(sa & sb) / max(1, min(len(sa), len(sb))) >= 0.68


def slugify(text):
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:60] or "story"


def next_id():
    nums = []
    for path in QUEUE.glob("*.json"):
        match = re.match(r"(\d+)-", path.name)
        if match:
            nums.append(int(match.group(1)))
    return max(nums) + 1 if nums else 1


def font(path, size):
    return ImageFont.truetype(path, size)


def wrap(draw, text, fnt, width):
    lines, current = [], ""
    for word in text.split():
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


def fit_text(draw, text, max_width, max_lines, start_size, min_size, spacing=8):
    size = start_size
    while size >= min_size:
        fnt = font(FONT_BOLD, size)
        lines = wrap(draw, text.upper(), fnt, max_width)
        if len(lines) <= max_lines:
            return fnt, lines, spacing
        size -= 3
    fnt = font(FONT_BOLD, min_size)
    return fnt, wrap(draw, text.upper(), fnt, max_width)[:max_lines], spacing


def draw_halftone(draw, box, step=22, radius=3, fill=PURPLE):
    x0, y0, x1, y1 = box
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=fill)


def download_image(url):
    if not url:
        return None
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "RapWire24-VisualFetcher/2.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            raw = response.read()
        if len(raw) > 12_000_000:
            return None
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        if image.width < 250 or image.height < 250:
            return None
        return image
    except Exception as exc:
        print(f"Visual download failed: {exc}")
        return None


def comicize_photo(image, size):
    image = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.42))
    image = ImageEnhance.Contrast(image).enhance(1.35)
    image = ImageEnhance.Color(image).enhance(1.25)
    image = image.filter(ImageFilter.UnsharpMask(radius=2, percent=180, threshold=3))
    image = image.quantize(colors=24).convert("RGB")
    # A restrained halftone overlay makes real source photography feel like a printed 80s panel.
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for y in range(0, size[1], 18):
        for x in range(0, size[0], 18):
            od.ellipse((x-2, y-2, x+2, y+2), fill=(20, 18, 29, 55))
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def draw_person(draw, cx, cy, scale, shirt=CYAN):
    # Stylized anonymous comic subject; never pretends to be a real person's likeness.
    head_r = int(28 * scale)
    draw.ellipse((cx-head_r, cy-head_r, cx+head_r, cy+head_r), fill=(214, 157, 111), outline=INK, width=max(3, int(5*scale)))
    draw.polygon([(cx-55*scale, cy+20*scale), (cx+55*scale, cy+20*scale), (cx+78*scale, cy+145*scale), (cx-78*scale, cy+145*scale)], fill=shirt, outline=INK)
    draw.line((cx-38*scale, cy+65*scale, cx-115*scale, cy+125*scale), fill=INK, width=max(5, int(10*scale)))
    draw.line((cx+38*scale, cy+65*scale, cx+115*scale, cy+125*scale), fill=INK, width=max(5, int(10*scale)))
    draw.line((cx-35*scale, cy+145*scale, cx-55*scale, cy+245*scale), fill=INK, width=max(5, int(11*scale)))
    draw.line((cx+35*scale, cy+145*scale, cx+55*scale, cy+245*scale), fill=INK, width=max(5, int(11*scale)))


def make_generated_scene(headline, size):
    # Local fallback illustration: gives every story a concrete visual even when the source has no photo.
    w, h = size
    canvas = Image.new("RGB", size, (31, 25, 47))
    d = ImageDraw.Draw(canvas)
    d.rectangle((0, 0, w, h), fill=(31, 25, 47))
    d.polygon([(0, h*0.48), (w, h*0.25), (w, h*0.75), (0, h*0.92)], fill=RED)
    draw_halftone(d, (0, 0, w, int(h*0.45)), step=24, radius=3, fill=(103, 57, 143))
    lower = headline.lower()
    if any(word in lower for word in ("police", "arrest", "trooper", "cop", "officer", "crime")):
        # Police car + anonymous person scene.
        car_y = int(h*0.64)
        d.rounded_rectangle((int(w*.08), car_y, int(w*.92), car_y+int(h*.20)), radius=28, fill=PAPER, outline=INK, width=9)
        d.rectangle((int(w*.08), car_y+int(h*.08), int(w*.92), car_y+int(h*.13)), fill=CYAN)
        d.polygon([(int(w*.30), car_y), (int(w*.42), car_y-int(h*.09)), (int(w*.66), car_y-int(h*.09)), (int(w*.77), car_y)], fill=PAPER, outline=INK)
        d.rectangle((int(w*.42), car_y-int(h*.07), int(w*.54), car_y-int(h*.01)), fill=(70, 120, 150), outline=INK, width=5)
        d.ellipse((int(w*.16), car_y+int(h*.16), int(w*.29), car_y+int(h*.29)), fill=INK)
        d.ellipse((int(w*.71), car_y+int(h*.16), int(w*.84), car_y+int(h*.29)), fill=INK)
        d.rectangle((int(w*.48), car_y-int(h*.05), int(w*.56), car_y+int(h*.01)), fill=YELLOW)
        draw_person(d, int(w*.78), int(h*.36), 0.9, shirt=YELLOW)
    elif any(word in lower for word in ("court", "judge", "lawsuit", "charged", "case")):
        d.rectangle((int(w*.15), int(h*.50), int(w*.85), int(h*.73)), fill=YELLOW, outline=INK, width=8)
        d.rectangle((int(w*.20), int(h*.42), int(w*.80), int(h*.50)), fill=PAPER, outline=INK, width=8)
        for x in (0.28, 0.43, 0.58, 0.73):
            d.rectangle((int(w*x), int(h*.50), int(w*x+.05*w), int(h*.72)), fill=PAPER, outline=INK, width=6)
        draw_person(d, int(w*.50), int(h*.27), 0.85, shirt=CYAN)
    elif any(word in lower for word in ("album", "song", "rapper", "rapper", "music", "concert", "tour", "mixtape")):
        d.rectangle((int(w*.15), int(h*.26), int(w*.85), int(h*.80)), fill=YELLOW, outline=INK, width=10)
        d.ellipse((int(w*.29), int(h*.36), int(w*.71), int(h*.78)), fill=INK)
        d.ellipse((int(w*.41), int(h*.48), int(w*.59), int(h*.66)), fill=YELLOW)
        draw_person(d, int(w*.50), int(h*.10), 0.7, shirt=RED)
        for i in range(5):
            d.line((int(w*.19), int(h*(.30+i*.09)), int(w*.81), int(h*(.30+i*.09))), fill=RED, width=5)
    else:
        draw_person(d, int(w*.50), int(h*.30), 1.05, shirt=CYAN)
        d.polygon([(int(w*.18), int(h*.66)), (int(w*.82), int(h*.55)), (int(w*.86), int(h*.85)), (int(w*.14), int(h*.94))], fill=YELLOW, outline=INK)
        d.ellipse((int(w*.24), int(h*.64), int(w*.39), int(h*.79)), fill=RED, outline=INK, width=6)
        d.ellipse((int(w*.61), int(h*.56), int(w*.76), int(h*.71)), fill=RED, outline=INK, width=6)
    return canvas


def visual_panel(headline, source, source_image, size):
    if source_image is not None:
        panel = comicize_photo(source_image, size)
        used_source = True
    else:
        panel = make_generated_scene(headline, size)
        used_source = False
    framed = Image.new("RGB", (size[0]+24, size[1]+24), INK)
    framed.paste(panel, (12, 12))
    return framed, used_source


def render_graphics(story_id, source, headline, body, source_image):
    MEDIA.mkdir(parents=True, exist_ok=True)
    feed1 = MEDIA / f"{story_id}-slide-1.jpg"
    feed2 = MEDIA / f"{story_id}-slide-2.jpg"
    story = MEDIA / f"{story_id}-story.jpg"
    W, H = 1080, 1350
    panel, used_source = visual_panel(headline, source, source_image, (1010, 535))

    # 4:5 feed slide: picture is a real focal point, headline is never allowed to overflow.
    im = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(im)
    draw_halftone(d, (0, 0, W, 185), step=22, radius=3, fill=(96, 55, 138))
    d.rectangle((48, 42, 410, 112), fill=YELLOW)
    d.text((68, 56), datetime.now(timezone.utc).strftime("%b %d, %Y").upper(), font=font(FONT_BOLD, 34), fill=INK)
    d.text((48, 132), "RAPWIRE 24/7", font=font(FONT_BOLD, 54), fill=PAPER)
    d.rectangle((48, 205, 1032, 211), fill=YELLOW)
    im.paste(panel.resize((1010, 535), Image.Resampling.LANCZOS), (35, 235))
    d = ImageDraw.Draw(im)
    d.rectangle((35, 770, 1045, 1320), fill=PURPLE)
    hf, lines, _ = fit_text(d, headline, 920, 4, 76, 43)
    y = 810
    for line in lines:
        d.text((78, y), line, font=hf, fill=INK, stroke_width=5, stroke_fill=INK)
        d.text((70, y-7), line, font=hf, fill=PAPER, stroke_width=1, stroke_fill=PAPER)
        y += hf.size + 8
    source_label = f"@{source}" if source else "RAPWIRE"
    d.text((70, 1255), f"BREAKING  •  {source_label}", font=font(FONT_BOLD, 27), fill=YELLOW)
    im.save(feed1, quality=94, optimize=True)

    # Second feed slide is deliberately simpler and more readable.
    im2 = Image.new("RGB", (W, H), (16, 16, 22))
    d2 = ImageDraw.Draw(im2)
    d2.rectangle((0, 0, W, 18), fill=YELLOW)
    d2.text((60, 55), "RAPWIRE 24/7", font=font(FONT_BOLD, 54), fill=PAPER)
    d2.text((60, 145), "THE DETAILS", font=font(FONT_BOLD, 42), fill=YELLOW)
    d2.rectangle((60, 205, 1020, 211), fill=YELLOW)
    body_text = body if body else headline
    body_lines = wrap(d2, body_text, font(FONT_REG, 43), 900)
    yy = 270
    for line in body_lines[:13]:
        d2.text((72, yy), line, font=font(FONT_REG, 43), fill=PAPER)
        yy += 62
    d2.rounded_rectangle((60, 1110, 1020, 1235), radius=18, fill=(30, 31, 39), outline=YELLOW, width=3)
    d2.text((88, 1145), f"SOURCE  @{source}", font=font(FONT_BOLD, 31), fill=PAPER)
    d2.text((60, 1280), "HIP-HOP  •  CULTURE  •  REAL-TIME", font=font(FONT_BOLD, 26), fill=YELLOW)
    im2.save(feed2, quality=94, optimize=True)

    # 9:16 story: completely separate composition. No more stuffing a 4:5 post into a Story.
    SW, SH = 1080, 1920
    st = Image.new("RGB", (SW, SH), INK)
    sd = ImageDraw.Draw(st)
    draw_halftone(sd, (0, 0, SW, 230), step=22, radius=3, fill=(96, 55, 138))
    sd.rectangle((52, 46, 405, 114), fill=YELLOW)
    sd.text((72, 59), datetime.now(timezone.utc).strftime("%b %d, %Y").upper(), font=font(FONT_BOLD, 33), fill=INK)
    sd.text((52, 140), "RAPWIRE 24/7", font=font(FONT_BOLD, 56), fill=PAPER)
    sd.rectangle((52, 218, 1028, 224), fill=YELLOW)
    story_panel = panel.resize((980, 700), Image.Resampling.LANCZOS)
    st.paste(story_panel, (50, 260))
    sd = ImageDraw.Draw(st)
    sd.polygon([(0, 960), (1080, 860), (1080, 1175), (0, 1280)], fill=RED)
    sf, slines, _ = fit_text(sd, headline, 920, 5, 72, 40)
    sy = 930
    for line in slines:
        sd.text((83, sy), line, font=sf, fill=INK, stroke_width=5, stroke_fill=INK)
        sd.text((75, sy-7), line, font=sf, fill=PAPER, stroke_width=1, stroke_fill=PAPER)
        sy += sf.size + 5
    sd.rectangle((50, 1360, 1030, 1735), fill=(247, 246, 239))
    detail_lines = wrap(sd, body_text, font(FONT_BOLD, 34), 900)
    dy = 1405
    for line in detail_lines[:7]:
        sd.text((80, dy), line, font=font(FONT_BOLD, 34), fill=INK)
        dy += 45
    sd.text((55, 1780), f"BREAKING  •  @{source}", font=font(FONT_BOLD, 31), fill=YELLOW)
    st.save(story, quality=94, optimize=True)
    return feed1, feed2, story, used_source


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
        if fp in seen or any(similar_story(fp, old) for old in seen if " " in old and len(old) > 30):
            continue
        item["fingerprint"] = fp
        fresh.append(item)
    fresh.sort(key=lambda x: x.get("pub_dt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    fresh = fresh[:MAX_NEW]
    if not fresh:
        print("Narro: no current source items.")
        return

    seq = next_id()
    for item in fresh:
        headline = clean(item["title"]) or "RapWire update"
        body = clean(item["description"]) or headline
        if len(body) > 700:
            body = body[:697].rsplit(" ", 1)[0] + "..."
        source = item["source"].lstrip("@").strip()
        story_id = f"{seq:03d}-{slugify(headline)}"
        source_image = download_image(item.get("image_url", ""))
        feed1, feed2, story, used_source = render_graphics(story_id, source, headline, body, source_image)
        source_url = item["link"] or FEED_URL
        caption = (
            f"{body}\n\nSource: @{source}\n{source_url}\n\n"
            "Follow @rapwire247 for hip-hop, culture, and real-time news."
        )
        queue_item = {
            "id": story_id,
            "status": "ready",
            "created_at": now.isoformat(),
            "source": source,
            "source_urls": [source_url],
            "source_guid": item["guid"],
            "source_title": headline,
            "source_image_url": item.get("image_url", ""),
            "source_published_at": item["pub_dt"].isoformat() if item.get("pub_dt") else item.get("pub", ""),
            "story_fingerprint": item["fingerprint"],
            "headline": headline,
            "body": body,
            "caption": caption,
            "threads_text": f"{headline}\n\n{body}\n\nSource: @{source}",
            "slides": [str(feed1.relative_to(ROOT)), str(feed2.relative_to(ROOT))],
            "story": str(story.relative_to(ROOT)),
            "visual_asset_type": "source_photo" if used_source else "original_graphic",
            "visual_asset_rights": "source_post_repost" if used_source else "owned",
            "photo_recency_checked": True,
            "photo_event_relevance": "event_specific" if used_source else "same_campaign",
            "photo_context_summary": "Source image supplied with the current source item." if used_source else "Original RapWire comic illustration generated from the current story topic.",
            "photo_capture_date": (item["pub_dt"].date().isoformat() if item.get("pub_dt") else now.date().isoformat()),
            "media_urls": [str(feed1.relative_to(ROOT)), str(feed2.relative_to(ROOT))],
            "story_media_url": str(story.relative_to(ROOT)),
        }
        (QUEUE / f"{story_id}.json").write_text(json.dumps(queue_item, indent=2) + "\n")
        print(f"Queued {story_id}: {'source photo' if used_source else 'original comic illustration'}")
        seq += 1


if __name__ == "__main__":
    main()
