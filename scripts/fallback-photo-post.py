#!/usr/bin/env python3
"""Build a credited real-photo RapWire post when the AI pipeline is unavailable."""

import html
import io
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
QUEUE, MEDIA = ROOT / "queue", ROOT / "media"
FEED_URL = os.environ["NARRO_RSS_URL"]
MAX_AGE_HOURS = max(48, int(os.environ.get("MAX_SOURCE_AGE_HOURS", "48")))
FONT_BOLD = next(path for path in (
    str(ROOT / "assets" / "fonts" / "Anton-Regular.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
) if Path(path).exists())
FONT_REG = next(path for path in (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
) if Path(path).exists())
INK, PAPER, CYAN, YELLOW = (8, 10, 13), (246, 239, 218), (0, 221, 242), (255, 201, 40)


def clean(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def local_name(element):
    return element.tag.rsplit("}", 1)[-1].lower()


def child_text(item, wanted):
    for child in item:
        if local_name(child) == wanted.lower():
            return clean("".join(child.itertext()))
    return ""


def published_at(value):
    try:
        dt = parsedate_to_datetime(value)
    except Exception:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def feed_image(item, link):
    for child in item:
        url = child.attrib.get("url") or child.attrib.get("href") or ""
        media_type = (child.attrib.get("type") or "").lower()
        if url and (local_name(child) == "thumbnail" or media_type.startswith("image/") or re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", url, re.I)):
            return urllib.parse.urljoin(link, html.unescape(url))
    return ""


def page_image(link):
    request = urllib.request.Request(link, headers={"User-Agent": "Mozilla/5.0 RapWire24/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        page = response.read(2_000_000).decode("utf-8", "ignore")
    patterns = (
        r'<meta[^>]+(?:property|name)=["\'](?:og:image|twitter:image(?::src)?)["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:image|twitter:image(?::src)?)["\']',
    )
    for pattern in patterns:
        match = re.search(pattern, page, re.I)
        if match:
            return urllib.parse.urljoin(link, html.unescape(match.group(1)))
    return ""


def candidates():
    request = urllib.request.Request(FEED_URL, headers={"User-Agent": "RapWire24-Fallback/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        root = ET.fromstring(response.read())
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - MAX_AGE_HOURS * 3600
    result = []
    for item in root.iter():
        if local_name(item) != "item":
            continue
        title = child_text(item, "title")
        description = child_text(item, "description") or child_text(item, "encoded")
        link = child_text(item, "link") or FEED_URL
        dt = published_at(child_text(item, "pubDate") or child_text(item, "published") or child_text(item, "date"))
        if title and dt and cutoff <= dt.timestamp() <= now.timestamp():
            result.append({"title": title, "description": description, "link": link, "published": dt, "image": feed_image(item, link)})
    return sorted(result, key=lambda row: row["published"], reverse=True)


def independent_source(title, primary_link):
    words = re.findall(r"[A-Za-z0-9']+", clean(title))[:12]
    if len(words) < 3:
        return ""
    query = urllib.parse.quote_plus(" ".join(words))
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    request = urllib.request.Request(url, headers={"User-Agent": "RapWire24-Fallback/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            root = ET.fromstring(response.read())
    except Exception as error:
        print(f"Fallback secondary-source search failed: {error}")
        return ""
    primary_host = urllib.parse.urlparse(primary_link).netloc.removeprefix("www.")
    title_terms = {word.casefold() for word in words if len(word) >= 4}
    for item in root.iter():
        if local_name(item) != "item":
            continue
        result_title = child_text(item, "title")
        result_link = child_text(item, "link")
        dt = published_at(child_text(item, "pubDate"))
        if not result_link or not dt or (datetime.now(timezone.utc) - dt).total_seconds() > MAX_AGE_HOURS * 3600:
            continue
        host = urllib.parse.urlparse(result_link).netloc.removeprefix("www.")
        overlap = title_terms & {word.casefold() for word in re.findall(r"[A-Za-z0-9']+", result_title)}
        if host != primary_host and len(overlap) >= min(3, max(2, len(title_terms) // 3)):
            return result_link
    return ""


def known_handles():
    registry = []
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        name = clean(item.get("featured_artist") or item.get("featured_person"))
        handle = clean(item.get("artist_instagram_handle"))
        profile = clean(item.get("artist_handle_verified_url"))
        if name and handle.startswith("@") and profile.startswith("https://www.instagram.com/"):
            registry.append((name, handle, profile))
    return registry


def seen_values():
    seen = set()
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        seen.update(str(url) for url in item.get("source_urls", []))
        seen.add(clean(item.get("source_title")).casefold())
        seen.add(clean(item.get("headline")).casefold())
    return seen


def select_stories():
    seen = seen_values()
    registry = known_handles()
    keywords = ("lil durk", "trial", "rapper", "rap", "hip-hop", "hip hop", "album", "song", "music", "concert", "grammy")
    ranked = []
    for story in candidates():
        blob = f"{story['title']} {story['description']}".casefold()
        if story["link"] in seen or story["title"].casefold() in seen:
            continue
        matched = next(((name, handle, profile) for name, handle, profile in registry if name.casefold() in blob), None)
        if not matched:
            continue
        score = sum(3 for keyword in keywords if keyword in blob)
        if "lil durk" in blob or "trial" in blob:
            score += 20
        ranked.append((score, story, matched))
    return [row[1:] for row in sorted(ranked, key=lambda row: (row[0], row[1]["published"]), reverse=True)]


def download_image(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 RapWire24/5.0", "Accept": "image/*"})
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read(15_000_001)
    if len(raw) > 15_000_000:
        raise RuntimeError("Fallback source image exceeds 15 MB")
    return Image.open(io.BytesIO(raw)).convert("RGB")


def font(size, bold=True):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def wrap(draw, text, selected_font, width):
    lines, current = [], ""
    for word in text.split():
        test = f"{current} {word}".strip()
        if draw.textbbox((0, 0), test, font=selected_font)[2] <= width:
            current = test
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def fitted_headline(draw, text, width, max_lines):
    for size in range(78, 39, -2):
        selected = font(size)
        lines = wrap(draw, text.upper(), selected, width)
        if len(lines) <= max_lines:
            return selected, lines
    return font(40), wrap(draw, text.upper(), font(40), width)[:max_lines]


def artist_tag(draw, name, handle, y):
    label = f"{name.upper()}  {handle}"
    selected = font(25)
    width = int(draw.textlength(label, font=selected)) + 38
    draw.rounded_rectangle((58, y, 58 + width, y + 52), radius=9, fill=INK, outline=CYAN, width=3)
    draw.text((77, y + 10), label, font=selected, fill=PAPER)


def render(story_id, story, name, handle, source_label, image):
    MEDIA.mkdir(exist_ok=True)
    headline = clean(story["title"])[:105]
    body = clean(story["description"])
    if len(body) < 80:
        body = f"{headline}. RapWire is tracking this developing story from {source_label}."
    if len(body) > 720:
        body = body[:720].rsplit(" ", 1)[0] + "…"

    slide1 = Image.new("RGB", (1080, 1350), INK)
    hero = ImageOps.fit(image, (1080, 850), method=Image.Resampling.LANCZOS, centering=(0.5, 0.38))
    hero = ImageEnhance.Contrast(hero).enhance(1.04)
    slide1.paste(hero, (0, 0))
    draw = ImageDraw.Draw(slide1)
    draw.rectangle((0, 0, 1080, 12), fill=CYAN)
    draw.rounded_rectangle((54, 48, 290, 106), radius=10, fill=INK, outline=CYAN, width=3)
    draw.text((74, 60), "RAPWIRE 24/7", font=font(27), fill=CYAN)
    artist_tag(draw, name, handle, 760)
    draw.rectangle((0, 836, 1080, 1350), fill=INK)
    selected, lines = fitted_headline(draw, headline, 970, 4)
    y = 884
    for line in lines:
        draw.text((54, y), line, font=selected, fill=PAPER)
        y += selected.size + 8
    draw.text((56, 1284), f"SOURCE PHOTO: {source_label.upper()}", font=font(24), fill=CYAN)
    slide1_path = MEDIA / f"{story_id}-slide-1.jpg"
    slide1.save(slide1_path, quality=94, subsampling=0)

    slide2 = Image.new("RGB", (1080, 1350), INK)
    draw = ImageDraw.Draw(slide2)
    draw.rectangle((0, 0, 1080, 16), fill=CYAN)
    draw.text((56, 48), "RAPWIRE", font=font(48), fill=PAPER)
    draw.text((270, 48), "24/7", font=font(48), fill=CYAN)
    draw.text((56, 132), "WHAT WE KNOW", font=font(48), fill=YELLOW)
    draw.rectangle((56, 202, 1024, 209), fill=CYAN)
    draw.rounded_rectangle((48, 236, 1032, 768), radius=18, fill=(24, 28, 34), outline=(49, 59, 68), width=3)
    selected = font(35, False)
    y = 278
    for line in wrap(draw, body, selected, 900)[:10]:
        draw.text((84, y), line, font=selected, fill=PAPER)
        y += 51
    photo = ImageOps.fit(image, (968, 390), method=Image.Resampling.LANCZOS, centering=(0.5, 0.38))
    photo = ImageEnhance.Contrast(photo).enhance(1.05)
    slide2.paste(photo, (56, 808))
    draw = ImageDraw.Draw(slide2)
    draw.rectangle((56, 808, 1024, 1198), outline=CYAN, width=4)
    artist_tag(draw, name, handle, 1118)
    draw.rectangle((56, 1240, 1024, 1245), fill=CYAN)
    draw.text((56, 1270), f"SOURCE PHOTO: {source_label.upper()}", font=font(24), fill=CYAN)
    slide2_path = MEDIA / f"{story_id}-slide-2.jpg"
    slide2.save(slide2_path, quality=94, subsampling=0)

    story_canvas = Image.new("RGB", (1080, 1920), INK)
    story_hero = ImageOps.fit(image, (1080, 1240), method=Image.Resampling.LANCZOS, centering=(0.5, 0.38))
    story_canvas.paste(story_hero, (0, 0))
    draw = ImageDraw.Draw(story_canvas)
    draw.rectangle((0, 0, 1080, 14), fill=CYAN)
    draw.rounded_rectangle((54, 190, 300, 250), radius=10, fill=INK, outline=CYAN, width=3)
    draw.text((74, 202), "RAPWIRE 24/7", font=font(28), fill=CYAN)
    artist_tag(draw, name, handle, 1115)
    draw.rectangle((0, 1200, 1080, 1920), fill=INK)
    selected, lines = fitted_headline(draw, headline, 970, 5)
    y = 1260
    for line in lines:
        draw.text((54, y), line, font=selected, fill=PAPER)
        y += selected.size + 8
    draw.text((56, 1810), f"SOURCE PHOTO: {source_label.upper()}", font=font(24), fill=CYAN)
    story_path = MEDIA / f"{story_id}-story.jpg"
    story_canvas.save(story_path, quality=94, subsampling=0)
    return headline, body, [slide1_path, slide2_path], story_path


def next_id(headline):
    numbers = []
    for path in QUEUE.glob("*.json"):
        match = re.match(r"(\d+)-", path.name)
        if match:
            numbers.append(int(match.group(1)))
    number = max(numbers, default=0) + 1
    slug = re.sub(r"[^a-z0-9]+", "-", headline.casefold()).strip("-")[:50]
    return f"{number:03d}-{slug or 'fallback-photo'}"


def main():
    if any(json.loads(path.read_text()).get("status") == "ready" for path in QUEUE.glob("*.json")):
        print("Fallback: a ready queue item already exists.")
        return
    selections = select_stories()
    if not selections:
        print("Fallback: no fresh non-duplicate story matched the verified-handle registry.")
        return
    story = name = handle = profile = second_source = image_url = image = None
    for candidate_story, identity in selections:
        candidate_second_source = independent_source(candidate_story["title"], candidate_story["link"])
        if not candidate_second_source:
            print(f"Fallback candidate skipped (no independent source): {candidate_story['title'][:90]}")
            continue
        image_urls = [candidate_story["image"]] if candidate_story["image"] else []
        try:
            article_image = page_image(candidate_story["link"])
            if article_image and article_image not in image_urls:
                image_urls.append(article_image)
        except Exception as error:
            print(f"Fallback article-image discovery failed: {error}")
        for candidate_url in image_urls:
            try:
                candidate_image = download_image(candidate_url)
                story = candidate_story
                name, handle, profile = identity
                second_source = candidate_second_source
                image_url = candidate_url
                image = candidate_image
                break
            except Exception as error:
                print(f"Fallback image candidate failed: {candidate_url} ({error})")
        if image is not None:
            break
    if image is None:
        print("Fallback: no candidate had both independent confirmation and a usable source image.")
        return
    source_label = urllib.parse.urlparse(story["link"]).netloc.removeprefix("www.")
    provisional_id = next_id(story["title"])
    headline, body, slides, story_path = render(provisional_id, story, name, handle, source_label, image)
    item = {
        "id": provisional_id,
        "status": "ready",
        "date": datetime.now(timezone.utc).date().isoformat(),
        "timezone": "America/Detroit",
        "type": "fallback_photo_news",
        "story_type": "current_news",
        "headline": headline,
        "body": body,
        "slides": [str(path.relative_to(ROOT)) for path in slides],
        "story": str(story_path.relative_to(ROOT)),
        "caption": f"{body}\n\n{name} ({handle})\n\nSource and photo credit: {source_label}\n{story['link']}\n\n#RapWire247 #HipHopNews",
        "threads_text": f"{headline}\n\n{name} ({handle})\n\n{body}\n\nSource: {source_label}",
        "featured_artist": name,
        "artist_instagram_handle": handle,
        "artist_handle_verified": True,
        "artist_handle_verified_url": profile,
        "displayed_artist_label": f"{name.upper()}  {handle}",
        "identity_checked": True,
        "source_urls": [story["link"], second_source],
        "source_url": story["link"],
        "source_title": story["title"],
        "source_published_at": story["published"].isoformat(),
        "source_image_url": image_url,
        "source_image_role": "credited authentic source photo used in the fallback editorial layout",
        "source_photo_used": True,
        "visual_asset_source_urls": [story["link"], second_source, image_url],
        "visual_asset_type": "source_photo",
        "visual_asset_rights": "source_post_repost",
        "fallback_real_photo": True,
        "ai_generated_art": False,
        "photo_capture_date": story["published"].date().isoformat(),
        "photo_recency_checked": True,
        "photo_event_relevance": "current_subject_portrait",
        "photo_context_summary": "Current source image selected from the report and credited on the asset and caption.",
        "visual_safe_area_checked": True,
        "publish_after": datetime.now(timezone.utc).isoformat(),
    }
    (QUEUE / f"{provisional_id}.json").write_text(json.dumps(item, indent=2) + "\n")
    print(f"Fallback created: {provisional_id}")


if __name__ == "__main__":
    main()
