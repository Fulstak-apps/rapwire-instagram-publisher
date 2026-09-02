#!/usr/bin/env python3
"""Local-first RapWire editor using Ollama.

This script deliberately does NOT publish anything. It reads approved/fresh stories,
selects and rewrites one story with a local Ollama model, applies deterministic QA,
and writes a queue JSON item with status=review by default. Use --dry-run to avoid
writing any files at all.

The existing GitHub/Meta publisher remains the source of truth for publication.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"
FEED_URL = os.environ.get(
    "NARRO_RSS_URL",
    "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f",
)
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")
MAX_SOURCE_AGE_HOURS = max(12, int(os.environ.get("MAX_SOURCE_AGE_HOURS", "48")))
MAX_CANDIDATES = max(1, min(30, int(os.environ.get("MAX_NEW_ITEMS", "12"))))
QA_THRESHOLD = max(0, min(100, int(os.environ.get("RAPWIRE_QA_THRESHOLD", "85"))))

APPROVED_SOURCE_HANDLES = {
    "akademiks",
    "nojumper",
    "poetikflakkonews",
    "traploreross",
    "saycheesetv",
    "theshaderoom",
    "worldstarhiphop",
    "detroitrapnews",
    "detroitrapdaily",
    "complexmusic",
    "gta6latest",
}
RAP_CENTRIC_SOURCES = APPROVED_SOURCE_HANDLES - {"theshaderoom", "gta6latest"}
RAP_TOPIC_TERMS = (
    " rap ", " rapper", "hip-hop", "hip hop", "hiphop", "album", "mixtape",
    "single", "track", "song", "producer", "bars", "verse", "freestyle",
    "diss", "beef", "record label", "tour", "concert", "festival", "stage",
    "trial", "court", "charged", "arrested", "sentenced", "plea", "shooting",
)
NON_NEWS_FLUFF = (
    "birthday", "adorable", "daddy duties", "relationship goals", "on vacay",
    "vacation", "outfit", "thirst trap", "roommate diaries", "scenarioz",
)


@dataclass
class Candidate:
    guid: str
    title: str
    description: str
    link: str
    published_at: str
    source_handle: str
    image_url: str = ""


def clean(value: str | None) -> str:
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def child_text(item: ET.Element, wanted: str) -> str:
    for child in item:
        if local_name(child.tag) == wanted.lower():
            return clean("".join(child.itertext()))
    return ""


def source_handle(title: str, link: str = "") -> str:
    match = re.match(r"\s*@([A-Za-z0-9._]+)\s*:", clean(title))
    if match:
        return match.group(1).casefold()
    parsed = urllib.parse.urlparse(link)
    if parsed.netloc.casefold().removeprefix("www.") == "instagram.com":
        first = parsed.path.strip("/").split("/", 1)[0]
        if first and first not in {"p", "reel", "stories"}:
            return first.casefold()
    return ""


def rap_relevant(title: str, description: str, handle: str) -> bool:
    blob = f" {clean(title).casefold()} {clean(description).casefold()} "
    if any(term in blob for term in NON_NEWS_FLUFF):
        return False
    if handle == "gta6latest":
        return any(term in blob for term in (" gta ", "gta 6", "grand theft auto", "rockstar games"))
    if handle in RAP_CENTRIC_SOURCES:
        return True
    return any(term in blob for term in RAP_TOPIC_TERMS)


def parse_date(value: str) -> datetime | None:
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


def feed_image(item: ET.Element, link: str) -> str:
    for child in item:
        url = child.attrib.get("url") or child.attrib.get("href") or ""
        media_type = (child.attrib.get("type") or "").lower()
        if url and (
            local_name(child.tag) == "thumbnail"
            or media_type.startswith("image/")
            or re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", url, re.I)
        ):
            return urllib.parse.urljoin(link, html.unescape(url))
    return ""


def fetch_feed() -> list[Candidate]:
    request = urllib.request.Request(
        FEED_URL,
        headers={"User-Agent": "RapWire24-LocalEditor/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    root = ET.fromstring(raw)
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - MAX_SOURCE_AGE_HOURS * 3600
    found: list[Candidate] = []
    for item in root.iter():
        if local_name(item.tag) != "item":
            continue
        title = child_text(item, "title")
        description = child_text(item, "description") or child_text(item, "encoded")
        link = child_text(item, "link") or FEED_URL
        guid = child_text(item, "guid") or link or title
        published = parse_date(
            child_text(item, "pubDate")
            or child_text(item, "published")
            or child_text(item, "date")
        )
        handle = source_handle(title, link)
        if not title or not published:
            continue
        if not (cutoff <= published.timestamp() <= now.timestamp()):
            continue
        if handle not in APPROVED_SOURCE_HANDLES:
            continue
        if not rap_relevant(title, description, handle):
            continue
        found.append(
            Candidate(
                guid=guid,
                title=title,
                description=description[:5000],
                link=link,
                published_at=published.isoformat(),
                source_handle=handle,
                image_url=feed_image(item, link),
            )
        )
    seen_titles: set[str] = set()
    unique: list[Candidate] = []
    for candidate in sorted(found, key=lambda c: c.published_at, reverse=True):
        key = re.sub(r"[^a-z0-9]+", " ", candidate.title.casefold()).strip()
        if key in seen_titles:
            continue
        seen_titles.add(key)
        unique.append(candidate)
    return unique[:MAX_CANDIDATES]


def existing_keys() -> set[str]:
    keys: set[str] = set()
    if not QUEUE.exists():
        return keys
    for path in QUEUE.glob("*.json"):
        try:
            item = json.loads(path.read_text())
        except Exception:
            continue
        for field in ("source_guid", "source_url", "story_fingerprint"):
            if item.get(field):
                keys.add(str(item[field]))
        for url in item.get("source_urls", []):
            keys.add(str(url))
    return keys


def page_metadata(url: str) -> dict[str, str]:
    """Deterministically gather public page metadata for extra context.

    This is intentionally conservative: no claim is trusted merely because a model says it.
    """
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 RapWire24-LocalEditor/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            page = response.read(1_500_000).decode("utf-8", "ignore")
    except Exception:
        return {}
    result: dict[str, str] = {}
    patterns = {
        "og_title": r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)',
        "og_description": r'<meta[^>]+(?:property|name)=["\']og:description["\'][^>]+content=["\']([^"\']+)',
        "og_image": r'<meta[^>]+(?:property|name)=["\']og:image["\'][^>]+content=["\']([^"\']+)',
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, page, re.I)
        if match:
            result[key] = clean(match.group(1))
    return result


def ollama_chat(prompt: str) -> str:
    payload = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "stream": False,
            "format": "json",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are RapWire 24/7's local newsroom editor. Use only the facts "
                        "in the supplied evidence. Never invent names, dates, quotes, legal "
                        "claims, Instagram handles, or context. Return valid JSON only."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "options": {"temperature": 0.15},
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as error:
        raise RuntimeError(
            f"Cannot reach Ollama at {OLLAMA_URL}. Start Ollama and pull {OLLAMA_MODEL}."
        ) from error
    content = data.get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("Ollama returned an empty response")
    return content


def build_evidence(candidate: Candidate) -> dict[str, Any]:
    meta = page_metadata(candidate.link)
    evidence = {
        "source_handle": candidate.source_handle,
        "source_url": candidate.link,
        "source_published_at": candidate.published_at,
        "feed_title": clean(candidate.title),
        "feed_description": clean(candidate.description),
        "page_title": meta.get("og_title", ""),
        "page_description": meta.get("og_description", ""),
        "image_url": candidate.image_url or meta.get("og_image", ""),
    }
    return evidence


def choose_story(candidates: list[Candidate]) -> tuple[Candidate, dict[str, Any]]:
    evidence = [build_evidence(candidate) for candidate in candidates]
    prompt = (
        "Choose exactly ONE strong, fresh RapWire story from the candidate evidence below. "
        "Prefer substantive rap/hip-hop developments over lifestyle fluff. GTA 6 is an occasional "
        "exception. Do not create facts that are absent from the evidence. Return JSON with keys: "
        "index (integer), headline (string, <=100 chars), body (90-180 words), caption (1-3 short "
        "paragraphs), category (breaking|music|beef|business|legal|culture|gta), featured_person "
        "(string or empty), content_format (photo_news|tweet_statement|video_repost). If evidence is "
        "too weak, set index to -1.\n\nCANDIDATES:\n"
        + json.dumps(evidence, ensure_ascii=False, indent=2)
    )
    raw = ollama_chat(prompt)
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Ollama did not return valid JSON: {raw[:500]}") from error
    idx = int(result.get("index", -1))
    if idx < 0 or idx >= len(candidates):
        raise RuntimeError("Local editor found no candidate strong enough to publish")
    return candidates[idx], result


def normalize_editorial(result: dict[str, Any]) -> dict[str, str]:
    headline = clean(str(result.get("headline", "")))
    body = clean(str(result.get("body", "")))
    caption = clean(str(result.get("caption", "")))
    category = clean(str(result.get("category", "culture"))).lower()
    featured = clean(str(result.get("featured_person", "")))
    content_format = clean(str(result.get("content_format", "photo_news"))).lower()
    allowed_categories = {"breaking", "music", "beef", "business", "legal", "culture", "gta"}
    allowed_formats = {"photo_news", "tweet_statement", "video_repost"}
    if category not in allowed_categories:
        category = "culture"
    if content_format not in allowed_formats:
        content_format = "photo_news"
    return {
        "headline": headline,
        "body": body,
        "caption": caption,
        "category": category,
        "featured_person": featured,
        "content_format": content_format,
    }


def qa_score(editorial: dict[str, str], candidate: Candidate, evidence: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    checks: dict[str, Any] = {}
    headline = editorial["headline"]
    body = editorial["body"]
    caption = editorial["caption"]
    body_words = re.findall(r"\b\w+\b", body)

    checks["headline_present"] = bool(headline)
    checks["headline_length_ok"] = 12 <= len(headline) <= 100
    checks["body_length_ok"] = 70 <= len(body_words) <= 220
    checks["caption_present"] = bool(caption)
    checks["source_approved"] = candidate.source_handle in APPROVED_SOURCE_HANDLES
    checks["source_recent"] = bool(parse_date(candidate.published_at))
    checks["source_url_present"] = candidate.link.startswith(("http://", "https://"))
    checks["image_reference_present"] = bool(evidence.get("image_url"))
    checks["no_placeholder_text"] = not bool(re.search(r"\b(?:tbd|todo|placeholder|lorem ipsum)\b", f"{headline} {body} {caption}", re.I))
    checks["no_unverified_handle"] = "@" not in editorial["featured_person"]

    weights = {
        "headline_present": 10,
        "headline_length_ok": 10,
        "body_length_ok": 15,
        "caption_present": 10,
        "source_approved": 15,
        "source_recent": 10,
        "source_url_present": 10,
        "image_reference_present": 10,
        "no_placeholder_text": 5,
        "no_unverified_handle": 5,
    }
    score = sum(weight for key, weight in weights.items() if checks[key])
    checks["score"] = score
    checks["threshold"] = QA_THRESHOLD
    checks["passed"] = score >= QA_THRESHOLD
    return score, checks


def fingerprint(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def next_id(headline: str) -> str:
    numbers: list[int] = []
    if QUEUE.exists():
        for path in QUEUE.glob("*.json"):
            match = re.match(r"(\d+)-", path.name)
            if match:
                numbers.append(int(match.group(1)))
    number = max(numbers, default=0) + 1
    slug = re.sub(r"[^a-z0-9]+", "-", headline.casefold()).strip("-")[:55] or "story"
    return f"{number:03d}-{slug}"


def queue_item(candidate: Candidate, editorial: dict[str, str], evidence: dict[str, Any], qa: dict[str, Any]) -> dict[str, Any]:
    story_id = next_id(editorial["headline"])
    return {
        "id": story_id,
        "status": "review",
        "local_editor": True,
        "local_editor_model": OLLAMA_MODEL,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": f"@{candidate.source_handle}",
        "source_handle": candidate.source_handle,
        "source_policy_checked": True,
        "rap_relevance_checked": True,
        "source_urls": [candidate.link],
        "source_url": candidate.link,
        "source_guid": candidate.guid,
        "source_title": candidate.title,
        "source_published_at": candidate.published_at,
        "story_fingerprint": fingerprint(editorial["headline"]),
        "headline": editorial["headline"],
        "body": editorial["body"],
        "rendered_body_text": editorial["body"],
        "caption": editorial["caption"],
        "threads_text": f"{editorial['headline']}\n\n{editorial['body']}\n\nSource: @{candidate.source_handle}",
        "featured_person": editorial["featured_person"],
        "content_format": editorial["content_format"],
        "category": editorial["category"],
        "source_image_url": evidence.get("image_url", ""),
        "source_photo_used": False,
        "visual_asset_type": "pending_review",
        "visual_asset_rights": "pending_review",
        "qa": qa,
        "qa_passed": bool(qa.get("passed")),
        "text_overflow_checked": False,
        "photo_recency_checked": False,
        "photo_event_relevance": "pending_review",
        "photo_context_summary": "Pending human or deterministic visual verification before ready status.",
        "slides": [],
        "story": "",
        "media_urls": [],
        "publish_blocked": True,
        "publish_block_reason": "Local editor output remains status=review until artwork/photo and final layout QA are complete.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a local Ollama RapWire draft without publishing")
    parser.add_argument("--dry-run", action="store_true", help="Print the draft JSON without writing queue files")
    parser.add_argument("--model", help="Override OLLAMA_MODEL for this run")
    args = parser.parse_args()
    global OLLAMA_MODEL
    if args.model:
        OLLAMA_MODEL = args.model

    existing = existing_keys()
    candidates = [
        c for c in fetch_feed()
        if c.guid not in existing and c.link not in existing
    ]
    if not candidates:
        print("RapWire local editor: no new approved candidates.")
        return 0

    candidate, raw_result = choose_story(candidates)
    editorial = normalize_editorial(raw_result)
    evidence = build_evidence(candidate)
    score, qa = qa_score(editorial, candidate, evidence)
    item = queue_item(candidate, editorial, evidence, qa)

    print(f"Selected: {editorial['headline']}")
    print(f"Source: @{candidate.source_handle} — {candidate.link}")
    print(f"QA: {score}/100 ({'PASS' if qa['passed'] else 'HOLD'})")
    print("Publishing remains blocked; this script only produces review drafts.")

    if args.dry_run:
        print(json.dumps(item, indent=2, ensure_ascii=False))
        return 0

    QUEUE.mkdir(parents=True, exist_ok=True)
    path = QUEUE / f"{item['id']}.json"
    path.write_text(json.dumps(item, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote review draft: {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
