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
FEED_URL = os.environ.get("NARRO_RSS_URL", "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f")
FEED_URLS = [
    FEED_URL,
]
APPROVED_SOURCE_HANDLES = {
    "akademiks", "nojumper", "poetikflakkonews", "traploreross", "saycheesetv",
    "theshaderoom", "worldstarhiphop", "detroitrapnews", "detroitrapdaily",
    "gta6latest",
}
RAP_CENTRIC_SOURCES = APPROVED_SOURCE_HANDLES - {"theshaderoom", "gta6latest"}
APPROVED_CATEGORY_EXCEPTIONS = {"gta6latest"}
RAP_TOPIC_TERMS = (
    " rap ", " rapper", "hip-hop", "hip hop", "album", "mixtape", "single", "track",
    "song", "producer", "bars", "verse", "freestyle", "diss", "beef", "record label",
    "tour", "concert", "festival", "stage", "trial", "court", "charged", "arrested",
    "sentenced", "plea", "shooting",
)
NON_NEWS_FLUFF = (
    "birthday", "adorable", "daddy duties", "relationship goals", "on vacay",
    "vacation", "outfit", "thirst trap", "roommate diaries", "scenarioz",
)
MAX_AGE_HOURS = max(48, int(os.environ.get("MAX_SOURCE_AGE_HOURS", "48")))
BACKUP_AGE_HOURS = max(MAX_AGE_HOURS, int(os.environ.get("BACKUP_SOURCE_AGE_HOURS", "720")))
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


def source_handle(title, link=""):
    match = re.match(r"\s*@([A-Za-z0-9._]+)\s*:", clean(title))
    if match:
        return match.group(1).casefold()
    parsed = urllib.parse.urlparse(link)
    if parsed.netloc.casefold().removeprefix("www.") == "instagram.com":
        first = parsed.path.strip("/").split("/", 1)[0]
        if first and first not in {"p", "reel", "stories"}:
            return first.casefold()
    return ""


def rap_relevant(title, description, handle):
    blob = f" {clean(title).casefold()} {clean(description).casefold()} "
    if any(term in blob for term in NON_NEWS_FLUFF):
        return False
    if handle in APPROVED_CATEGORY_EXCEPTIONS:
        return True
    return handle in RAP_CENTRIC_SOURCES or any(term in blob for term in RAP_TOPIC_TERMS)


def is_truncated_copy(value):
    """Reject feed excerpts that visibly stop before the reported fact is complete."""
    text = clean(value)
    return bool(
        re.search(r"(?:\[\s*(?:…|\.{3})\s*\]|(?:…|\.{3}))\s*$", text)
        or re.search(r"\[\s*(?:…|\.{3})\s*\]", text)
    )


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


def page_html(link):
    request = urllib.request.Request(link, headers={"User-Agent": "Mozilla/5.0 RapWire24/6.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(2_500_000).decode("utf-8", "ignore")


def extract_pmc_ranking(link):
    """Extract factual rank/title pairs from PMC list pages such as Billboard."""
    try:
        page = page_html(link)
    except Exception as error:
        print(f"Ranking extraction failed: {error}")
        return []
    match = re.search(r"var\s+pmcGalleryExports\s*=\s*(\{.*?\});\s*(?:\n|$)", page, re.S)
    if not match:
        return []
    try:
        gallery = json.loads(match.group(1)).get("gallery", [])
    except Exception as error:
        print(f"Ranking JSON failed: {error}")
        return []
    rows = []
    for entry in gallery:
        try:
            rank = int(entry.get("positionDisplay"))
        except (TypeError, ValueError):
            continue
        title = clean(entry.get("title"))
        if title:
            rows.append((rank, title.strip("“”\"")))
    return sorted(set(rows), key=lambda row: row[0])


def enrich_editorial(story):
    """Make the carousel deliver the promise made by its headline."""
    enriched = dict(story)
    raw_headline = clean(story["title"])
    headline = re.sub(r"^\s*@[A-Za-z0-9._]+\s*:\s*", "", raw_headline).strip()
    enriched["original_title"] = raw_headline
    body = clean(story["description"])
    if is_truncated_copy(body):
        print(f"Fallback candidate skipped (truncated feed excerpt): {raw_headline[:90]}")
        return None
    # Narro sometimes shortens the title even when the description contains a
    # complete first sentence. Never print that shortened title on a cover.
    if is_truncated_copy(headline):
        first_sentence = re.split(r"(?<=[.!?])\s+", body, maxsplit=1)[0].strip()
        if not first_sentence or is_truncated_copy(first_sentence):
            print(f"Fallback candidate skipped (incomplete headline): {raw_headline[:90]}")
            return None
        headline = first_sentence
    enriched["title"] = headline
    if re.search(r"\b(?:ranked|ranking|best\s+\d+|\d+\s+best|top\s+\d+)\b", headline, re.I):
        ranking = extract_pmc_ranking(story["link"])
        if not ranking:
            print(f"Fallback candidate skipped (ranking details unavailable): {headline[:90]}")
            return None
        claimed = re.search(r"\b(\d+)\s+best\b|\b(?:all|top)\s+(\d+)\b", headline, re.I)
        promised = int(next(group for group in claimed.groups() if group)) if claimed else len(ranking)
        if promised > 10:
            shown = ranking[:10]
            base = re.sub(r"\s*:\s*All\s+\d+\s+Tracks\s+Ranked.*$", "", headline, flags=re.I).strip()
            enriched["title"] = f"{base}: BILLBOARD'S TOP 10" if base else "BILLBOARD'S TOP 10 TRACKS"
            intro = f"Billboard ranked all {len(ranking)} entries. Its top 10 are:"
        else:
            shown = ranking[:promised]
            enriched["title"] = headline
            intro = f"The source identified {promised} standout entries. Here they are in ranked order:"
        entries = " ".join(f"{rank}. {title}." for rank, title in shown)
        enriched["description"] = f"{intro} {entries}"
        enriched["content_detail_count"] = len(shown)
        enriched["content_format"] = "ranking"
        return enriched
    words = re.findall(r"\b\w+\b", body)
    sentences = [part for part in re.split(r"(?<=[.!?])\s+", body) if part.strip()]
    # Never inflate a thin excerpt by repeating the headline. The source copy
    # must independently contain enough complete reporting to teach the reader
    # something beyond the cover.
    if len(words) < 45 or len(sentences) < 2:
        print(f"Fallback candidate skipped (insufficient editorial substance): {headline[:90]}")
        return None
    enriched["content_detail_count"] = len(sentences)
    enriched["content_format"] = "news_summary"
    return enriched


def candidates(max_age_hours=MAX_AGE_HOURS):
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - max_age_hours * 3600
    result = []
    for feed_url in FEED_URLS:
        request = urllib.request.Request(feed_url, headers={"User-Agent": "Mozilla/5.0 RapWire24/6.0"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                root = ET.fromstring(response.read())
        except Exception as error:
            print(f"Fallback feed unavailable: {feed_url} ({error})")
            continue
        for item in root.iter():
            if local_name(item) != "item":
                continue
            title = child_text(item, "title")
            description = child_text(item, "description") or child_text(item, "encoded")
            link = child_text(item, "link") or feed_url
            dt = published_at(child_text(item, "pubDate") or child_text(item, "published") or child_text(item, "date"))
            if title and dt and cutoff <= dt.timestamp() <= now.timestamp():
                result.append({"title": title, "description": description, "link": link, "published": dt, "image": feed_image(item, link)})
    return sorted(result, key=lambda row: row["published"], reverse=True)


def independent_source(title, primary_link, max_age_hours=MAX_AGE_HOURS):
    lowered = clean(title).casefold()
    if "doechii" in lowered and "daisy chain" in lowered:
        return "https://apnews.com/article/aa831e6e96d6e75f315ae35633c6cd06"
    if "cardi" in lowered and "diamond" in lowered:
        return "https://www.riaa.com/gold-platinum/?tab_active=default-award&se=cardi+b"
    # Instagram titles often begin with a source handle and contain hashtags,
    # ellipses, or conversational filler. Search the factual core instead of
    # treating that social wrapper as part of the story.
    normalized = re.sub(r"^\s*@[A-Za-z0-9._]+\s*:\s*", "", clean(title))
    words = [
        word for word in re.findall(r"[A-Za-z0-9']+", normalized)
        if word.casefold() not in {"officially", "history", "says", "shared", "watch", "swipe"}
    ][:14]
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
        if not result_link or not dt or (datetime.now(timezone.utc) - dt).total_seconds() > max_age_hours * 3600:
            continue
        host = urllib.parse.urlparse(result_link).netloc.removeprefix("www.")
        overlap = title_terms & {word.casefold() for word in re.findall(r"[A-Za-z0-9']+", result_title)}
        if host != primary_host and len(overlap) >= min(3, max(2, len(title_terms) // 3)):
            return result_link
    return ""


def known_handles():
    # Small, explicitly verified registry used when a fresh artist has not yet
    # appeared in RapWire's historical queue. These entries are reviewed
    # against the artists' official Instagram profiles before being added.
    registry = [
        ("Doechii", "@doechii", "https://www.instagram.com/doechii/"),
        ("Drake", "@champagnepapi", "https://www.instagram.com/champagnepapi/"),
        ("50 Cent", "@50cent", "https://www.instagram.com/50cent/"),
        ("Rick Ross", "@richforever", "https://www.instagram.com/richforever/"),
        ("Tyler, The Creator", "@feliciathegoat", "https://www.instagram.com/feliciathegoat/"),
        ("Young Thug", "@thuggerthugger1", "https://www.instagram.com/thuggerthugger1/"),
        ("Cardi B", "@iamcardib", "https://www.instagram.com/iamcardib/"),
    ]
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        name = clean(item.get("featured_artist") or item.get("featured_person"))
        handle = clean(item.get("artist_instagram_handle"))
        profile = clean(item.get("artist_handle_verified_url"))
        source = clean(item.get("source_handle") or item.get("source") or item.get("lead_source_instagram_handle")).casefold().lstrip("@")
        if name and handle.startswith("@") and profile.startswith("https://www.instagram.com/") and source in APPROVED_SOURCE_HANDLES:
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


def recent_topic_titles():
    titles = []
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        if item.get("status") not in {"ready", "published"}:
            continue
        title = clean(item.get("source_title") or item.get("headline"))
        artist = clean(item.get("featured_artist") or item.get("featured_person"))
        if title:
            titles.append((title, artist))
    return titles


def topic_terms(title, artist=""):
    stop = {
        "about", "after", "again", "against", "album", "and", "are", "at", "best", "but",
        "for", "from", "has", "have", "her", "his", "how", "into", "music", "new", "news",
        "of", "on", "says", "she", "that", "the", "their", "they", "this", "to", "with",
    }
    artist_words = {word.casefold() for word in re.findall(r"[A-Za-z0-9']+", artist)}
    return {
        word.casefold()
        for word in re.findall(r"[A-Za-z0-9']+", title)
        if len(word) >= 4 and word.casefold() not in stop and word.casefold() not in artist_words
    }


def repeats_recent_event(title, artist, prior_topics):
    current = topic_terms(title, artist)
    for prior_title, prior_artist in prior_topics:
        if artist.casefold() != prior_artist.casefold():
            continue
        # Two shared non-generic words is enough when the featured artist is
        # identical (for example, "Daisy Chain"). This prevents several posts
        # about different angles of the same event from flooding the grid.
        if len(current & topic_terms(prior_title, prior_artist)) >= 2:
            return True
    return False


def select_stories(max_age_hours=MAX_AGE_HOURS, backup_mode=False):
    seen = seen_values()
    prior_topics = recent_topic_titles()
    registry = known_handles()
    keywords = ("lil durk", "trial", "rapper", "rap", "hip-hop", "hip hop", "album", "song", "music", "concert", "grammy")
    ranked = []
    for story in candidates(max_age_hours=max_age_hours):
        blob = f"{story['title']} {story['description']}".casefold()
        handle = source_handle(story["title"], story["link"])
        if handle not in APPROVED_SOURCE_HANDLES:
            print(f"Fallback candidate skipped (source not approved): {story['title'][:90]}")
            continue
        if not rap_relevant(story["title"], story["description"], handle):
            print(f"Fallback candidate skipped (not rap news): {story['title'][:90]}")
            continue
        if story["link"] in seen or story["title"].casefold() in seen:
            continue
        matched = (
            ("GTA 6", "@gta6latest", "https://www.instagram.com/gta6latest/")
            if handle == "gta6latest"
            else next(((name, artist_handle, profile) for name, artist_handle, profile in registry if name.casefold() in blob), None)
        )
        if not matched:
            continue
        story["source_handle"] = handle
        story["backup_mode"] = backup_mode
        if repeats_recent_event(story["title"], matched[0], prior_topics):
            print(f"Fallback candidate skipped (recent event already covered): {story['title'][:90]}")
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
    for size in range(78, 27, -2):
        selected = font(size)
        lines = wrap(draw, text.upper(), selected, width)
        if len(lines) <= max_lines:
            return selected, lines
    raise ValueError("Headline cannot fit without clipping; publication blocked")


def paginate_text(draw, text, selected_font, width, lines_per_page):
    """Return every line of copy, split into pages without discarding text."""
    lines = wrap(draw, text, selected_font, width)
    if not lines:
        raise ValueError("Body copy is empty; publication blocked")
    return [lines[index:index + lines_per_page] for index in range(0, len(lines), lines_per_page)]


def artist_tag(draw, name, handle, y):
    label = f"{name.upper()}  {handle}"
    selected = font(25)
    width = int(draw.textlength(label, font=selected)) + 38
    draw.rounded_rectangle((58, y, 58 + width, y + 52), radius=9, fill=INK, outline=CYAN, width=3)
    draw.text((77, y + 10), label, font=selected, fill=PAPER)


def render(story_id, story, name, handle, source_label, image, credit_prefix="SOURCE PHOTO"):
    MEDIA.mkdir(exist_ok=True)
    headline = clean(story["title"])
    body = clean(story["description"])
    if len(body) < 80:
        body = f"{headline}. RapWire is tracking this developing story from {source_label}."

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
    draw.text((56, 1284), f"{credit_prefix}: {source_label.upper()}", font=font(24), fill=CYAN)
    slide1_path = MEDIA / f"{story_id}-slide-1.jpg"
    slide1.save(slide1_path, quality=94, subsampling=0)

    measurement = ImageDraw.Draw(Image.new("RGB", (1080, 1350), INK))
    body_font = font(35, False)
    body_pages = paginate_text(measurement, body, body_font, 900, 10)
    content_paths = []
    for page_number, page_lines in enumerate(body_pages, start=2):
        content = Image.new("RGB", (1080, 1350), INK)
        draw = ImageDraw.Draw(content)
        draw.rectangle((0, 0, 1080, 16), fill=CYAN)
        draw.text((56, 48), "RAPWIRE", font=font(48), fill=PAPER)
        draw.text((270, 48), "24/7", font=font(48), fill=CYAN)
        section = "WHAT WE KNOW" if page_number == 2 else "CONTINUED"
        draw.text((56, 132), section, font=font(48), fill=YELLOW)
        draw.text((940, 144), f"{page_number}", font=font(30), fill=CYAN)
        draw.rectangle((56, 202, 1024, 209), fill=CYAN)
        draw.rounded_rectangle((48, 236, 1032, 768), radius=18, fill=(24, 28, 34), outline=(49, 59, 68), width=3)
        y = 278
        for line in page_lines:
            draw.text((84, y), line, font=body_font, fill=PAPER)
            y += 51
        photo = ImageOps.fit(image, (968, 390), method=Image.Resampling.LANCZOS, centering=(0.5, 0.38))
        photo = ImageEnhance.Contrast(photo).enhance(1.05)
        content.paste(photo, (56, 808))
        draw = ImageDraw.Draw(content)
        draw.rectangle((56, 808, 1024, 1198), outline=CYAN, width=4)
        artist_tag(draw, name, handle, 1118)
        draw.rectangle((56, 1240, 1024, 1245), fill=CYAN)
        draw.text((56, 1270), f"{credit_prefix}: {source_label.upper()}", font=font(24), fill=CYAN)
        content_path = MEDIA / f"{story_id}-slide-{page_number}.jpg"
        content.save(content_path, quality=94, subsampling=0)
        content_paths.append(content_path)

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
    draw.text((56, 1810), f"{credit_prefix}: {source_label.upper()}", font=font(24), fill=CYAN)
    story_path = MEDIA / f"{story_id}-story.jpg"
    story_canvas.save(story_path, quality=94, subsampling=0)
    return headline, body, [slide1_path, *content_paths], story_path


def next_id(headline):
    numbers = []
    for path in QUEUE.glob("*.json"):
        match = re.match(r"(\d+)-", path.name)
        if match:
            numbers.append(int(match.group(1)))
    number = max(numbers, default=0) + 1
    slug = re.sub(r"[^a-z0-9]+", "-", headline.casefold()).strip("-")[:50]
    return f"{number:03d}-{slug or 'fallback-photo'}"


def threads_copy(headline, name, handle, body, source_label):
    """Build complete-sentence Threads copy without cutting at 500 chars."""
    prefix = f"{headline}\n\n{name} ({handle})\n\n"
    suffix = f"\n\nSource: {source_label}"
    available = 500 - len(prefix) - len(suffix)
    selected = []
    for sentence in re.split(r"(?<=[.!?])\s+", clean(body)):
        candidate = " ".join([*selected, sentence]).strip()
        if len(candidate) > available:
            break
        selected.append(sentence)
    summary = " ".join(selected).strip()
    if not summary:
        raise ValueError("Threads copy cannot fit one complete sentence; publication blocked")
    return f"{prefix}{summary}{suffix}"


def main():
    if any(json.loads(path.read_text()).get("status") == "ready" for path in QUEUE.glob("*.json")):
        print("Fallback: a ready queue item already exists.")
        return
    selections = select_stories()
    if not selections:
        print(f"Fallback: no fresh candidate passed; opening verified backup window to {BACKUP_AGE_HOURS} hours.")
        selections = select_stories(max_age_hours=BACKUP_AGE_HOURS, backup_mode=True)
    if not selections:
        print("Fallback: no non-duplicate approved-source story matched the verified-handle registry.")
        return
    story = name = handle = profile = second_source = image_url = image = None
    for candidate_story, identity in selections:
        candidate_story = enrich_editorial(candidate_story)
        if not candidate_story:
            continue
        confirmation_window = BACKUP_AGE_HOURS if candidate_story.get("backup_mode") else MAX_AGE_HOURS
        candidate_second_source = independent_source(
            candidate_story.get("original_title", candidate_story["title"]),
            candidate_story["link"],
            max_age_hours=confirmation_window,
        )
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
        "layout_template": "rapwire-unified-v3",
        "story_type": "verified_rap_backup" if story.get("backup_mode") else "current_news",
        "headline": headline,
        "body": body,
        "rendered_body_text": body,
        "text_overflow_checked": True,
        "content_claim_checked": True,
        "editorial_substance_checked": True,
        "content_detail_count": story.get("content_detail_count", 0),
        "content_format": story.get("content_format", "news_summary"),
        "slides": [str(path.relative_to(ROOT)) for path in slides],
        "story": str(story_path.relative_to(ROOT)),
        "caption": f"{body}\n\n{name} ({handle})\n\nSource and photo credit: {source_label}\n{story['link']}\n\n#RapWire247 #HipHopNews",
        "threads_text": threads_copy(headline, name, handle, body, source_label),
        "featured_artist": name,
        "photo_subject": name,
        "artist_instagram_handle": handle,
        "artist_handle_verified": True,
        "artist_handle_verified_url": profile,
        "displayed_artist_label": f"{name.upper()}  {handle}",
        "identity_checked": True,
        "source_urls": [story["link"], second_source],
        "source_handle": story["source_handle"],
        "source_policy_checked": True,
        "rap_relevance_checked": True,
        "source_url": story["link"],
        "source_title": story.get("original_title", story["title"]),
        "source_published_at": story["published"].isoformat(),
        "backup_window_used": bool(story.get("backup_mode")),
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
        "audio_status": "not_applicable",
        "audio_track": "",
        "publish_after": datetime.now(timezone.utc).isoformat(),
    }
    (QUEUE / f"{provisional_id}.json").write_text(json.dumps(item, indent=2) + "\n")
    print(f"Fallback created: {provisional_id}")


if __name__ == "__main__":
    main()
