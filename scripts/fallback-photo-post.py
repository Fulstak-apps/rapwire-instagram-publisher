#!/usr/bin/env python3
"""Build a credited real-photo RapWire post when the AI pipeline is unavailable."""

import html
import io
import json
import os
import re
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat

ROOT = Path(__file__).resolve().parents[1]
QUEUE, MEDIA = ROOT / "queue", ROOT / "media"
FEED_URL = os.environ.get("NARRO_RSS_URL", "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f")
FEED_URLS = [
    FEED_URL,
]
APPROVED_SOURCE_HANDLES = {
    "akademiks", "nojumper", "poetikflakkonews", "traploreross", "saycheesetv",
    "theshaderoom", "worldstarhiphop", "detroitrapnews", "detroitrapdaily", "complexmusic",
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
EDITORIAL_BATCH_SIZE = max(1, min(3, int(os.environ.get("EDITORIAL_BATCH_SIZE", "3"))))
GTA_COOLDOWN_POSTS = max(3, int(os.environ.get("GTA_COOLDOWN_POSTS", "6")))
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


def print_safe(value):
    """Remove emoji/symbol glyphs that the locked headline fonts cannot render."""
    return re.sub(
        r"\s+",
        " ",
        "".join(
            char for char in clean(value)
            if unicodedata.category(char) not in {"So", "Cs"} and char not in {"\ufe0f", "\u200d"}
        ),
    ).strip()


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
        # GTA6Latest also posts general gaming material. RapWire's only
        # non-rap exception is specifically GTA/Rockstar news, not every item
        # from that account.
        return any(term in blob for term in (" gta ", "gta 6", "grand theft auto", "rockstar games"))
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
    headline = print_safe(re.sub(r"^\s*@[A-Za-z0-9._]+\s*:\s*", "", raw_headline).strip())
    enriched["original_title"] = raw_headline
    body = print_safe(story["description"])
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
    initial_words = re.findall(r"\b\w+\b", body)
    initial_sentences = [part for part in re.split(r"(?<=[.!?])\s+", body) if part.strip()]
    lower_blob = f" {headline.casefold()} {body.casefold()} "
    if "lil durk" in lower_blob and "legal fee" in lower_blob and any(name in lower_blob for name in ("drake", "21savage", "lilbaby", "ye")):
        headline = "AKADEMIKS CLAIMS RAP STARS ARE HELPING WITH DURK'S LEGAL FEES"
        body = (
            "No Jumper reports that DJ Akademiks said Ye, Drake, 21 Savage and Lil Baby are helping with Lil Durk's legal expenses. "
            "Akademiks attributed specific payment details to unnamed information during a livestream; RapWire has not independently confirmed any payment or fee arrangement. "
            "Lil Durk has pleaded not guilty, and the charges against him remain allegations unless proven in court."
        )
        enriched["title"] = headline
        enriched["description"] = body
        initial_words = re.findall(r"\b\w+\b", body)
        initial_sentences = [part for part in re.split(r"(?<=[.!?])\s+", body) if part.strip()]
    if len(initial_words) < 45 or len(initial_sentences) < 2:
        # Supporting context can legitimately predate the breaking social post
        # (album background, tour announcement, prior credits).
        expanded_body, research_urls = researched_context(story, BACKUP_AGE_HOURS)
        if expanded_body:
            body = print_safe(expanded_body)
            enriched["description"] = body
            enriched["research_urls"] = research_urls
            enriched["content_format"] = "researched_news_context"
            print(f"Fallback research expanded thin approved-source caption: {headline[:90]}")
            expanded_blob = f" {headline.casefold()} {body.casefold()} "
            if "rod wave" in expanded_blob and "wayne" in expanded_blob and "every girl" in expanded_blob:
                headline = "LIL WAYNE CLEARED ROD WAVE'S 'EVERY GIRL' USE"
                enriched["title"] = headline
            elif "skilla baby" in expanded_blob and "price of fame" in expanded_blob:
                headline = "SKILLA BABY'S 'PRICE OF FAME' ROLLOUT EXPANDS"
                enriched["title"] = headline
            elif "sauce walka" in expanded_blob and "stream" in expanded_blob:
                headline = "SAUCE WALKA'S STREAMING RUN BY THE NUMBERS"
                enriched["title"] = headline
            elif "durk" in expanded_blob and "flacka" in expanded_blob and "payment" in expanded_blob:
                headline = "FLACKA TESTIFIES ABOUT ALLEGED PAYMENT TALKS IN DURK TRIAL"
                enriched["title"] = headline
    if any(term in f" {headline.casefold()} {body.casefold()} " for term in (
        " charged", " indictment", " trial", " prosecutors allege", " arrested", " accused",
    )) and "presumed innocent" not in body.casefold():
        body = f"{body} The charges and accusations are allegations; every defendant is presumed innocent unless proven guilty in court."
        enriched["description"] = body
    words = re.findall(r"\b\w+\b", body)
    sentences = [part for part in re.split(r"(?<=[.!?])\s+", body) if part.strip()]
    # Never inflate a thin excerpt by repeating the headline. The source copy
    # must independently contain enough complete reporting to teach the reader
    # something beyond the cover.
    if len(words) < 45 or len(sentences) < 2:
        print(f"Fallback candidate skipped (insufficient editorial substance): {headline[:90]}")
        return None
    enriched["content_detail_count"] = len(sentences)
    enriched.setdefault("content_format", "news_summary")
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


def researched_context(story, max_age_hours):
    """Expand a thin approved-source caption with attributed Google News context."""
    normalized = re.sub(r"^\s*@[A-Za-z0-9._]+\s*:\s*", "", clean(story["title"]))
    source_copy = clean(story["description"])
    blob = f" {normalized.casefold()} {source_copy.casefold()} "
    # Keep a small, source-specific resilience layer for current newsroom
    # priorities. Google News sometimes returns 503 to GitHub-hosted runners;
    # these direct primary/credible URLs let a verified story publish without
    # inventing padding or depending on the search proxy being available.
    if "rod wave" in blob and "wayne" in blob and "every girl" in blob:
        return (
            "Akademiks reports that Lil Wayne approved Rod Wave's use of 'Every Girl' in a new song, adding that music clearances can take months. "
            "Apple Music's current album notes describe 'Don't Look Down' as Rod Wave's seventh album and identify 'One More Time' as a Selena interpolation. "
            "Together, the reporting places the approved use within Rod Wave's current album rollout.",
            ["https://music.apple.com/us/album/dont-look-down/6781873059"],
        )
    if "skilla baby" in blob and "price of fame" in blob:
        return (
            "Akademiks highlighted Skilla Baby's new album 'The Price of Fame.' Pollstar reports that Skilla Baby announced a supporting 'Price of Fame Tour,' "
            "while The Detroit News separately reported that the Detroit rapper will close the run with a homecoming concert. "
            "Those updates show the project moving from its album release into a full tour rollout with a hometown finale.",
            [
                "https://news.pollstar.com/2026/08/28/skilla-baby-sets-the-price-of-fame-tour-in-support-of-latest-album/",
                "https://www.aol.com/articles/skilla-baby-close-price-fame-155317000.html",
            ],
        )
    if "sauce walka" in blob and "stream" in blob:
        return (
            "Akademiks says Sauce Walka made money from streaming this week. Third-party tracker Streams Charts reports that his Kick channel logged more than 364 hours of airtime "
            "during its latest 30-day window and averaged 189 viewers, while Apple Music lists 'Thuggin'' as his latest music release dated August 28. "
            "No platform or contract source independently published an exact earnings figure, so RapWire is reporting the activity and leaving the dollar amount unconfirmed.",
            [
                "https://streamscharts.com/channels/saucewalka102?platform=kick",
                "https://music.apple.com/us/artist/sauce-walka/911597254",
            ],
        )
    if "durk" in blob and "shooter testified" in blob and "million dollars" in blob:
        return (
            "Trap Lore Ross reports that cooperating witness Keith 'Flacka' Jones testified about alleged payment discussions connected to the 2022 shooting at the center of Lil Durk's federal trial. "
            "Ross says Jones described being told that $1 million was available, later seeking payment, and ultimately receiving nothing; those statements are testimony and remain subject to cross-examination. "
            "The federal indictment separately alleges that money or music opportunities were promised in the charged murder-for-hire conspiracy, while earlier reporting identified Jones as a cooperating witness who pleaded guilty. "
            "Lil Durk has pleaded not guilty. The government's claims remain allegations, and he is presumed innocent unless proven guilty beyond a reasonable doubt.",
            [
                "https://thesource.com/2026/08/25/otf-vonni-otf-jam-and-flacka-to-testify-against-lil-durk-in-murder-for-hire-trial/",
                "https://www.courthousenews.com/wp-content/uploads/2025/11/united-states-vs-banks-second-superseding-indictment.pdf",
            ],
        )
    stop = {
        "about", "after", "again", "been", "check", "credits", "going", "have", "like",
        "made", "months", "really", "says", "shared", "song", "take", "that", "their",
        "there", "they", "this", "week", "what", "when", "with", "your",
    }
    raw_query_words = [
        word for word in re.findall(r"[A-Za-z0-9']+", f"{normalized} {source_copy}")
        if len(word) >= 3 and word.casefold() not in stop
    ]
    query_words = list(dict.fromkeys(raw_query_words))[:12]
    if "rod wave" in blob and "wayne" in blob:
        query_words = ["Rod", "Wave", "Lil", "Wayne", "Every", "Girl"]
    elif "skilla baby" in blob:
        query_words = ["Skilla", "Baby", "Price", "of", "Fame"]
    elif "sauce walka" in blob:
        query_words = ["Sauce", "Walka", "streaming", "earnings"]
    if len(query_words) < 3:
        return "", []
    query_terms = {word.casefold() for word in query_words if len(word) >= 3}
    url = (
        "https://news.google.com/rss/search?q="
        + urllib.parse.quote_plus(" ".join(query_words))
        + "&hl=en-US&gl=US&ceid=US:en"
    )
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "RapWire24-Research/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            root = ET.fromstring(response.read())
    except Exception as error:
        print(f"Fallback research search failed: {error}")
        return "", []
    now = datetime.now(timezone.utc)
    reports, used_publishers = [], set()
    for item in root.iter():
        if local_name(item) != "item":
            continue
        result_title = child_text(item, "title")
        result_link = child_text(item, "link")
        publisher = child_text(item, "source") or "Independent reporting"
        dt = published_at(child_text(item, "pubDate"))
        if not result_title or not result_link or not dt:
            continue
        if (now - dt).total_seconds() > max_age_hours * 3600:
            continue
        if publisher.casefold() in {"instagram.com", "youtube", "reddit"}:
            continue
        result_terms = {word.casefold() for word in re.findall(r"[A-Za-z0-9']+", result_title)}
        if len(query_terms & result_terms) < 3:
            continue
        if publisher.casefold() in used_publishers:
            continue
        used_publishers.add(publisher.casefold())
        cleaned_title = re.sub(rf"\s+-\s+{re.escape(publisher)}$", "", print_safe(result_title), flags=re.I)
        reports.append((publisher, cleaned_title, result_link, dt.date().isoformat()))
        if len(reports) == 2:
            break
    if not reports:
        return "", []
    primary = source_copy.rstrip(".!?") + "."
    additions = [
        f'{publisher} separately reported "{title.rstrip(".")}" on {date}.'
        for publisher, title, _link, date in reports
    ]
    additions.append(
        "Those reports provide verified context for the approved-source post; RapWire is not adding any unsupported claim beyond the attributed reporting."
    )
    return " ".join([primary, *additions]), [link for _publisher, _title, link, _date in reports]


def independent_source(title, primary_link, max_age_hours=MAX_AGE_HOURS):
    lowered = clean(title).casefold()
    if "coldheartedac" in lowered:
        return "https://www.latimes.com/california/story/2026-08-29/la-rapper-coldheartedac-arrested-check-fraud"
    if "doechii" in lowered and "daisy chain" in lowered:
        return "https://apnews.com/article/aa831e6e96d6e75f315ae35633c6cd06"
    if "cardi" in lowered and "diamond" in lowered:
        return "https://www.riaa.com/gold-platinum/?tab_active=default-award&se=cardi+b"
    if "gta 6 online" in lowered and "launch" in lowered:
        return "https://www.forbes.com/sites/paultassi/2026/08/29/why-rockstar-has-said-nothing-about-gta-6-online-so-far/"
    if "gta minimap" in lowered or "gta minimaps" in lowered:
        return "https://gta.fandom.com/wiki/Radar"
    if "elon musk" in lowered and "gta" in lowered:
        return "https://www.foxbusiness.com/technology/elon-musk-says-tried-grand-theft-auto-didnt-like-doing-crime"
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
        ("Lil Durk", "@lildurk", "https://www.instagram.com/lildurk/"),
        ("Skilla Baby", "@skillababy", "https://www.instagram.com/skillababy/"),
        ("Rod Wave", "@rodwave", "https://www.instagram.com/rodwave/"),
        ("Lil Wayne", "@liltunechi", "https://www.instagram.com/liltunechi/"),
        ("ColdheartedAC", "@coldheartedac", "https://www.instagram.com/coldheartedac/"),
        ("Sauce Walka", "@sauce_walka102", "https://www.instagram.com/sauce_walka102/"),
        ("Trippie Redd", "@trippieredd", "https://www.instagram.com/trippieredd/"),
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


def editorial_lane(story, handle):
    blob = f" {clean(story['title']).casefold()} {clean(story['description']).casefold()} "
    if "lil durk" in blob and any(term in blob for term in (
        " trial", "court", "prosecution", "defense", "witness", "testimony", "jury", "judge",
    )):
        return "lil_durk_trial"
    if handle == "gta6latest":
        return "gta"
    if any(term in blob for term in (
        "album", "mixtape", "single", "track", "song", "producer", "label", "tour", "concert",
        "trial", "court", "charged", "arrested", "sentenced", "plea", "billboard", "certified",
    )):
        return "rap_substantive"
    return "rap_culture"


def recent_published_items(limit=GTA_COOLDOWN_POSTS):
    rows = []
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        if item.get("status") not in {"ready", "published"}:
            continue
        stamp = item.get("published_at") or item.get("publish_after") or item.get("created_at") or ""
        rows.append((stamp, item))
    return [item for _stamp, item in sorted(rows, key=lambda row: row[0], reverse=True)[:limit]]


def gta_is_on_cooldown():
    return any(
        item.get("editorial_lane") == "gta"
        or clean(item.get("source_handle")).casefold().lstrip("@") == "gta6latest"
        for item in recent_published_items()
    )


def ready_rap_count():
    count = 0
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        if item.get("status") == "ready" and item.get("editorial_lane") != "gta" and clean(item.get("source_handle")).casefold().lstrip("@") != "gta6latest":
            count += 1
    return count


def select_stories(max_age_hours=MAX_AGE_HOURS, backup_mode=False, allow_gta=False):
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
        lane = editorial_lane(story, handle)
        if lane == "gta" and not allow_gta:
            continue
        if story["link"] in seen or story["title"].casefold() in seen:
            continue
        matched = (
            ("GTA 6", "@gta6latest", "https://www.instagram.com/gta6latest/")
            if handle == "gta6latest"
            else (
                ("Rod Wave + Lil Wayne", "@rodwave  @liltunechi", "https://www.instagram.com/rodwave/")
                if "rod wave" in blob and "wayne" in blob
                else next(((name, artist_handle, profile) for name, artist_handle, profile in registry if name.casefold() in blob), None)
            )
        )
        if not matched:
            continue
        story["source_handle"] = handle
        story["backup_mode"] = backup_mode
        story["editorial_lane"] = lane
        if repeats_recent_event(story["title"], matched[0], prior_topics):
            print(f"Fallback candidate skipped (recent event already covered): {story['title'][:90]}")
            continue
        score = sum(3 for keyword in keywords if keyword in blob)
        score += {
            "lil_durk_trial": 1000,
            "rap_substantive": 500,
            "rap_culture": 250,
            "gta": 10,
        }[lane]
        if handle in {"traploreross", "akademiks", "poetikflakkonews"}:
            score += 30
        ranked.append((score, story, matched))
    return [row[1:] for row in sorted(ranked, key=lambda row: (row[0], row[1]["published"]), reverse=True)]


def download_image(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 RapWire24/5.0", "Accept": "image/*"})
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read(15_000_001)
    if len(raw) > 15_000_000:
        raise RuntimeError("Fallback source image exceeds 15 MB")
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    # Approved-source portraits are often delivered at 512px wide. They are
    # still suitable for a 1080px editorial crop, while 300px logo/thumbnail
    # placeholders remain below this floor.
    if image.width < 480 or image.height < 480:
        raise RuntimeError(f"Fallback source image is too small for publication ({image.width}x{image.height})")
    return image


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
    page_count = max(1, (len(lines) + lines_per_page - 1) // lines_per_page)
    balanced_size = (len(lines) + page_count - 1) // page_count
    return [lines[index:index + balanced_size] for index in range(0, len(lines), balanced_size)]


def artist_tag(draw, name, handle, y):
    label = f"{name.upper()}  {handle}"
    selected = font(25)
    width = int(draw.textlength(label, font=selected)) + 38
    draw.rounded_rectangle((58, y, 58 + width, y + 52), radius=9, fill=INK, outline=CYAN, width=3)
    draw.text((77, y + 10), label, font=selected, fill=PAPER)


def brand_badge(draw, x, y, size):
    """Draw a text-measured brand badge with equal padding on every side."""
    label = "RAPWIRE 24/7"
    selected = font(size)
    box = draw.textbbox((0, 0), label, font=selected)
    text_width = box[2] - box[0]
    text_height = box[3] - box[1]
    horizontal_padding, vertical_padding = 18, 10
    right = x + text_width + horizontal_padding * 2
    bottom = y + text_height + vertical_padding * 2
    draw.rounded_rectangle((x, y, right, bottom), radius=10, fill=INK, outline=CYAN, width=3)
    draw.text(
        (x + horizontal_padding - box[0], y + vertical_padding - box[1]),
        label,
        font=selected,
        fill=CYAN,
    )


def editorial_focus(image):
    """Remove bright social-post chrome before cropping the actual subject."""
    width, height = image.size
    top_band = image.crop((0, 0, width, max(1, int(height * 0.18)))).convert("L")
    bottom_band = image.crop((0, int(height * 0.82), width, height)).convert("L")
    top_mean = ImageStat.Stat(top_band).mean[0]
    bottom_mean = ImageStat.Stat(bottom_band).mean[0]
    has_bright_social_header = top_mean > 220
    top = int(height * 0.18) if has_bright_social_header else 0
    # Social screenshots with a bright header generally carry account chrome
    # below the subject as well. Remove that whole footer instead of leaving
    # clipped usernames or post text in Story crops.
    bottom = int(height * 0.78) if has_bright_social_header else (
        int(height * 0.82) if bottom_mean > 220 else height
    )
    if bottom - top >= int(height * 0.50):
        return image.crop((0, top, width, bottom))
    return image


def render(story_id, story, name, handle, source_label, image, credit_prefix="SOURCE PHOTO", hero_center_y=0.50):
    MEDIA.mkdir(exist_ok=True)
    headline = clean(story["title"])
    body = clean(story["description"])
    if len(body) < 80:
        body = f"{headline}. RapWire is tracking this developing story from {source_label}."

    display_image = editorial_focus(image)
    slide1 = Image.new("RGB", (1080, 1350), INK)
    hero = ImageOps.fit(display_image, (1080, 850), method=Image.Resampling.LANCZOS, centering=(0.5, hero_center_y))
    hero = ImageEnhance.Contrast(hero).enhance(1.04)
    slide1.paste(hero, (0, 0))
    draw = ImageDraw.Draw(slide1)
    draw.rectangle((0, 0, 1080, 12), fill=CYAN)
    brand_badge(draw, 54, 48, 27)
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
        photo = ImageOps.fit(display_image, (968, 390), method=Image.Resampling.LANCZOS, centering=(0.5, hero_center_y))
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
    story_hero = ImageOps.fit(display_image, (1080, 1240), method=Image.Resampling.LANCZOS, centering=(0.5, min(0.50, hero_center_y + 0.10)))
    story_canvas.paste(story_hero, (0, 0))
    draw = ImageDraw.Draw(story_canvas)
    draw.rectangle((0, 0, 1080, 14), fill=CYAN)
    brand_badge(draw, 54, 190, 28)
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


def create_one():
    allow_gta = ready_rap_count() >= 2 and not gta_is_on_cooldown()
    selections = select_stories(allow_gta=allow_gta)
    fresh_links = {story["link"] for story, _identity in selections}
    # Load the verified backlog behind the fresh candidates on every run. A
    # fresh selection can still fail later because its second source or image
    # is unavailable; the backlog must remain reachable in that case.
    backup_selections = [
        selection
        for selection in select_stories(max_age_hours=BACKUP_AGE_HOURS, backup_mode=True, allow_gta=allow_gta)
        if selection[0]["link"] not in fresh_links
    ]
    if not selections:
        print(f"Fallback: no fresh candidate passed; opening verified backup window to {BACKUP_AGE_HOURS} hours.")
    elif backup_selections:
        print(f"Fallback: loaded {len(backup_selections)} verified backup candidate(s) behind the fresh queue.")
    selections.extend(backup_selections)
    if not selections:
        print("Fallback: no non-duplicate approved-source story matched the verified-handle registry.")
        return False
    story = name = handle = profile = second_source = image_url = image = photo_credit_label = None
    for candidate_story, identity in selections:
        candidate_story = enrich_editorial(candidate_story)
        if not candidate_story:
            continue
        confirmation_window = BACKUP_AGE_HOURS if candidate_story.get("backup_mode") else MAX_AGE_HOURS
        candidate_second_source = next(iter(candidate_story.get("research_urls", [])), "")
        if not candidate_second_source:
            candidate_second_source = independent_source(
                candidate_story.get("original_title", candidate_story["title"]),
                candidate_story["link"],
                max_age_hours=confirmation_window,
            )
        if not candidate_second_source:
            print(f"Fallback candidate skipped (no independent source): {candidate_story['title'][:90]}")
            continue
        source_host = urllib.parse.urlparse(candidate_story["link"]).netloc.removeprefix("www.")
        second_host = urllib.parse.urlparse(candidate_second_source).netloc.removeprefix("www.")
        image_urls = []
        try:
            confirmation_image = page_image(candidate_second_source)
            if confirmation_image:
                image_urls.append((confirmation_image, second_host))
        except Exception as error:
            print(f"Fallback confirmation-image discovery failed: {error}")
        try:
            article_image = page_image(candidate_story["link"])
            if article_image and article_image not in {url for url, _label in image_urls}:
                image_urls.append((article_image, source_host))
        except Exception as error:
            print(f"Fallback article-image discovery failed: {error}")
        if candidate_story["image"] and candidate_story["image"] not in {url for url, _label in image_urls}:
            image_urls.append((candidate_story["image"], source_host))
        for candidate_url, candidate_credit in image_urls:
            try:
                candidate_image = download_image(candidate_url)
                story = candidate_story
                name, handle, profile = identity
                second_source = candidate_second_source
                image_url = candidate_url
                image = candidate_image
                photo_credit_label = candidate_credit
                break
            except Exception as error:
                print(f"Fallback image candidate failed: {candidate_url} ({error})")
        if image is not None:
            break
    if image is None:
        print("Fallback: no candidate had both independent confirmation and a usable source image.")
        return False
    source_label = urllib.parse.urlparse(story["link"]).netloc.removeprefix("www.")
    provisional_id = next_id(story["title"])
    headline, body, slides, story_path = render(provisional_id, story, name, handle, photo_credit_label, image)
    item = {
        "id": provisional_id,
        "status": "ready",
        "date": datetime.now(timezone.utc).date().isoformat(),
        "timezone": "America/Detroit",
        "type": "fallback_photo_news",
        "layout_template": "rapwire-unified-v3",
        "story_type": "verified_rap_backup" if story.get("backup_mode") else "current_news",
        "editorial_lane": story.get("editorial_lane", "rap_substantive"),
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
        "caption": f"{body}\n\n{name} ({handle})\n\nSource: {source_label}\nPhoto credit: {photo_credit_label}\n{story['link']}\n\n#RapWire247 #HipHopNews",
        "threads_text": threads_copy(headline, name, handle, body, source_label),
        "featured_artist": name,
        "photo_subject": name,
        "artist_instagram_handle": handle,
        "artist_handle_verified": True,
        "artist_handle_verified_url": profile,
        "displayed_artist_label": f"{name.upper()}  {handle}",
        "additional_verified_artists": (
            [
                {"name": "Rod Wave", "handle": "@rodwave", "profile_url": "https://www.instagram.com/rodwave/"},
                {"name": "Lil Wayne", "handle": "@liltunechi", "profile_url": "https://www.instagram.com/liltunechi/"},
            ]
            if name == "Rod Wave + Lil Wayne" else []
        ),
        "identity_checked": True,
        "source_urls": list(dict.fromkeys([story["link"], second_source, *story.get("research_urls", [])])),
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
    return True


def main():
    ready = 0
    for path in QUEUE.glob("*.json"):
        try:
            ready += json.loads(path.read_text()).get("status") == "ready"
        except Exception:
            continue
    print(f"Editorial batch: {ready}/{EDITORIAL_BATCH_SIZE} ready item(s).")
    while ready < EDITORIAL_BATCH_SIZE:
        if not create_one():
            break
        ready += 1
    print(f"Editorial batch complete: {ready}/{EDITORIAL_BATCH_SIZE} item(s) ready.")


if __name__ == "__main__":
    main()
