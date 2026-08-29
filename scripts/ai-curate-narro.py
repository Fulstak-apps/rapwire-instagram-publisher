#!/usr/bin/env python3
"""AI-first RapWire pipeline: read every Narro item, curate with GPT, generate original comic art, and build Instagram assets."""
import base64
import html
import json
import os
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from openai import OpenAI
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
MEDIA = ROOT / "media"
FEED_URL = os.environ.get("NARRO_RSS_URL", "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f")
MAX_NEW = int(os.environ.get("MAX_NEW_ITEMS", "6"))
MAX_AGE_HOURS = int(os.environ.get("MAX_SOURCE_AGE_HOURS", "24"))
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise SystemExit("OPENAI_API_KEY is required for the AI RapWire pipeline")

client = OpenAI(api_key=OPENAI_API_KEY)
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
INK = (18, 16, 27)
PAPER = (248, 247, 239)
YELLOW = (248, 204, 47)
PURPLE = (70, 43, 105)
RED = (137, 25, 48)
CYAN = (31, 190, 204)


def clean(v):
    v = html.unescape(v or "")
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", v)).strip()


def child_text(item, name):
    for c in item:
        if c.tag.rsplit("}", 1)[-1].lower() == name.lower():
            return clean(c.text)
    return ""


def parse_date(v):
    if not v:
        return None
    try:
        dt = parsedate_to_datetime(v)
    except Exception:
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fetch_narro():
    req = urllib.request.Request(FEED_URL, headers={"User-Agent": "RapWire24-AI/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        root = ET.fromstring(r.read())
    out = []
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1].lower() != "item":
            continue
        title = child_text(item, "title")
        link = child_text(item, "link")
        guid = child_text(item, "guid") or link or title
        desc = child_text(item, "description") or child_text(item, "encoded")
        pub = child_text(item, "pubDate") or child_text(item, "published") or child_text(item, "date")
        author = child_text(item, "author") or child_text(item, "creator")
        if title and (link or guid):
            out.append({"title": title, "description": desc, "link": link, "guid": guid, "pub": pub, "author": author})
    return out


def existing():
    seen = set()
    for p in QUEUE.glob("*.json"):
        try:
            x = json.loads(p.read_text())
            seen.add(x.get("source_guid") or x.get("source_url") or "")
        except Exception:
            pass
    return seen


def curate(item):
    prompt = f"""You are the senior editor for RapWire 24/7, a hip-hop and culture news brand.\n\nEvaluate this Narro feed item. Decide if it is worth a RapWire post TODAY. Prefer meaningful breaking/current hip-hop, rap, artists, music business, entertainment/culture, viral moments, crime stories involving notable culture figures, Detroit/urban culture, and major celebrity developments. Reject generic politics, weather, finance, sports unrelated to hip-hop, ads, rumors with no substance, stale posts, and weak promotional content.\n\nReturn ONLY valid JSON with: keep (boolean), importance (0-100), headline (max 90 chars), story (80-120 words, factual and clear), image_scene (one detailed sentence describing an original editorial illustration), caption (a concise Instagram caption with source attribution). Do not invent facts. If the feed item does not contain enough information to responsibly summarize, keep=false.\n\nTITLE: {item['title']}\nDESCRIPTION: {item['description'][:5000]}\nSOURCE/AUTHOR: {item['author']}\nLINK: {item['link']}"""
    r = client.responses.create(model="gpt-5.6-luna", input=prompt)
    text = r.output_text.strip()
    text = re.sub(r"^```json\s*|\s*```$", "", text, flags=re.I)
    return json.loads(text)


def generate_art(scene):
    prompt = f"""Create an ORIGINAL editorial illustration for RapWire 24/7 based on this scene: {scene}\n\nStyle: authentic 1980s underground comic-book drawing, hand-inked linework, Ben-Day/halftone print dots, slightly imperfect vintage registration, bold flat comic colors, dramatic perspective, gritty newsstand print texture, premium collectible comic panel. Make the people and environment feel specific to the event, but do not copy or recreate any source photograph. No text, no captions, no logos, no watermark. The image must look like an actual illustrated comic panel, not a vector infographic and not a photograph. Leave some visual breathing room for typography to be added later."""
    result = client.images.generate(model="gpt-image-2", prompt=prompt, size="1024x1536", output_format="png")
    data = result.data[0].b64_json
    return base64.b64decode(data)


def wrap(draw, text, font, width):
    lines, cur = [], ""
    for word in text.split():
        trial = (cur + " " + word).strip()
        if draw.textbbox((0, 0), trial, font=font)[2] <= width:
            cur = trial
        else:
            if cur: lines.append(cur)
            cur = word
    if cur: lines.append(cur)
    return lines


def fit(draw, text, width, max_lines, size=92, min_size=42):
    while size >= min_size:
        f = ImageFont.truetype(FONT_BOLD, size)
        lines = wrap(draw, text.upper(), f, width)
        if len(lines) <= max_lines:
            return f, lines
        size -= 4
    f = ImageFont.truetype(FONT_BOLD, min_size)
    return f, wrap(draw, text.upper(), f, width)[:max_lines]


def rapwire(draw, xy, size):
    f = ImageFont.truetype(FONT_BOLD, size)
    draw.text(xy, "RAPWIRE", font=f, fill=PAPER, stroke_width=1, stroke_fill=INK)


def make_assets(story_id, art_bytes, headline, story):
    MEDIA.mkdir(parents=True, exist_ok=True)
    art_path = MEDIA / f"{story_id}-ai-comic.png"
    art_path.write_bytes(art_bytes)
    art = Image.open(art_path).convert("RGB")

    # Slide 1: illustration first, clean RAPWIRE branding, no spray-paint treatment.
    s1 = Image.new("RGB", (1080, 1350), INK)
    panel = ImageOps.fit(art, (1080, 930), method=Image.Resampling.LANCZOS, centering=(0.5, 0.48))
    s1.paste(panel, (0, 0))
    d = ImageDraw.Draw(s1)
    d.rectangle((0, 930, 1080, 1350), fill=PURPLE)
    d.rectangle((0, 930, 1080, 946), fill=YELLOW)
    rapwire(d, (54, 968), 42)
    f, lines = fit(d, headline, 960, 3, 82, 40)
    y = 1030
    for line in lines:
        d.text((54, y), line, font=f, fill=PAPER, stroke_width=1, stroke_fill=INK)
        y += f.size + 8
    s1_path = MEDIA / f"{story_id}-slide1.jpg"
    s1.save(s1_path, "JPEG", quality=94, optimize=True)

    # Slide 2: tell the story clearly; still feels like a comic magazine page.
    s2 = Image.new("RGB", (1080, 1350), PAPER)
    d = ImageDraw.Draw(s2)
    d.rectangle((0, 0, 1080, 145), fill=INK)
    rapwire(d, (54, 43), 48)
    d.rectangle((54, 175, 1026, 205), fill=YELLOW)
    hf = ImageFont.truetype(FONT_BOLD, 56)
    d.text((54, 230), "WHAT HAPPENED", font=hf, fill=INK)
    body_font = ImageFont.truetype(FONT_REG, 40)
    lines = wrap(d, story, body_font, 950)
    y = 335
    for line in lines[:18]:
        d.text((54, y), line, font=body_font, fill=INK)
        y += 55
    # Small comic strip panel along the bottom.
    thumb = ImageOps.fit(art, (360, 250), method=Image.Resampling.LANCZOS)
    s2.paste(thumb, (666, 1035))
    d = ImageDraw.Draw(s2)
    d.rectangle((54, 1035, 630, 1285), fill=PURPLE)
    d.text((80, 1080), "RAPWIRE", font=ImageFont.truetype(FONT_BOLD, 46), fill=PAPER)
    d.text((80, 1145), "HIP-HOP • CULTURE • REAL-TIME", font=ImageFont.truetype(FONT_BOLD, 25), fill=YELLOW)
    s2_path = MEDIA / f"{story_id}-slide2.jpg"
    s2.save(s2_path, "JPEG", quality=94, optimize=True)

    # Story is a true 9:16 layout, not a stretched feed post.
    st = Image.new("RGB", (1080, 1920), INK)
    st_art = ImageOps.fit(art, (1080, 1130), method=Image.Resampling.LANCZOS, centering=(0.5, 0.48))
    st.paste(st_art, (0, 0))
    d = ImageDraw.Draw(st)
    d.rectangle((0, 1130, 1080, 1920), fill=PURPLE)
    rapwire(d, (54, 1170), 46)
    sf, slines = fit(d, headline, 970, 4, 70, 38)
    y = 1235
    for line in slines:
        d.text((54, y), line, font=sf, fill=PAPER)
        y += sf.size + 6
    story_font = ImageFont.truetype(FONT_REG, 34)
    sy = y + 24
    for line in wrap(d, story, story_font, 970)[:8]:
        d.text((54, sy), line, font=story_font, fill=PAPER)
        sy += 46
    st_path = MEDIA / f"{story_id}-story.jpg"
    st.save(st_path, "JPEG", quality=94, optimize=True)
    return s1_path, s2_path, st_path


def next_id():
    nums = []
    for p in QUEUE.glob("*.json"):
        m = re.match(r"(\d+)-", p.name)
        if m: nums.append(int(m.group(1)))
    return max(nums) + 1 if nums else 1


items = fetch_narro()
seen = existing()
now = datetime.now(timezone.utc)
items = [x for x in items if x["guid"] not in seen and (parse_date(x["pub"]) is None or (now - parse_date(x["pub"]).astimezone(timezone.utc)).total_seconds() <= MAX_AGE_HOURS * 3600)]
items.sort(key=lambda x: parse_date(x["pub"]) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

created = 0
for raw in items:
    if created >= MAX_NEW:
        break
    try:
        decision = curate(raw)
    except Exception as exc:
        print(f"AI curation failed for {raw['title']}: {exc}")
        continue
    if not decision.get("keep") or int(decision.get("importance", 0)) < 55:
        continue
    story_id = f"{next_id():04d}-{re.sub(r'[^a-z0-9]+', '-', decision['headline'].lower()).strip('-')[:50]}"
    try:
        art = generate_art(decision["image_scene"])
        s1, s2, st = make_assets(story_id, art, decision["headline"], decision["story"])
    except Exception as exc:
        print(f"AI art failed for {raw['title']}: {exc}")
        continue
    item = {
        "status": "ready",
        "story_type": "current_news",
        "source": clean(raw["author"]) or "Narro",
        "source_title": raw["title"],
        "source_url": raw["link"],
        "source_guid": raw["guid"],
        "source_published_at": raw["pub"],
        "headline": decision["headline"],
        "body": decision["story"],
        "caption": decision["caption"],
        "threads_text": decision["caption"],
        "visual_asset_type": "original_graphic",
        "visual_asset_rights": "owned",
        "photo_event_relevance": "same_campaign",
        "photo_context_summary": "AI-generated original 1980s comic illustration based on the current story; no source-blog photo used.",
        "source_image_url": "",
        "slides": [str(s1.relative_to(ROOT)), str(s2.relative_to(ROOT))],
        "story": str(st.relative_to(ROOT)),
        "media_urls": [str(s1.relative_to(ROOT)), str(s2.relative_to(ROOT))],
        "story_media_url": str(st.relative_to(ROOT)),
        "relevance_score": int(decision["importance"]),
        "created_at": now.isoformat(),
    }
    (QUEUE / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
    created += 1
    print(f"Created AI RapWire story: {story_id}")

print(f"AI Narro pipeline: created {created} original story/stories from {len(items)} fresh Narro candidates.")
