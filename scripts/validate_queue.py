#!/usr/bin/env python3
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image

MIN_PHOTO_YEAR = 2024


def fail(message):
    print(f"ERROR: {message}")
    return 1


def main():
    if len(sys.argv) != 2:
        print("usage: validate_queue.py QUEUE_ITEM.json")
        return 2

    item_path = Path(sys.argv[1]).resolve()
    root = item_path.parents[1]
    item = json.loads(item_path.read_text())
    errors = 0

    required = [
        "status", "date", "timezone", "headline", "body", "slides", "caption",
        "threads_text", "photo_subject", "audio_status", "identity_checked",
        "source_urls", "visual_asset_source_urls", "visual_asset_rights",
        "photo_capture_date", "photo_recency_checked", "photo_event_relevance",
        "photo_context_summary", "publish_after", "source_image_url", "source_image_role",
        "layout_template",
    ]
    for field in required:
        if field not in item or item[field] in ("", [], None):
            errors += fail(f"missing required field {field}")

    if item.get("status") != "ready":
        errors += fail("status must be ready")
    if item.get("timezone") != "America/Detroit":
        errors += fail("timezone must be America/Detroit")
    if item.get("body") and not item.get("caption", "").startswith(item["body"]):
        errors += fail("caption must begin with the exact slide-2 body")
    if item.get("status") == "ready":
        if item.get("layout_template") != "rapwire-unified-v3":
            errors += fail("layout_template must be rapwire-unified-v3")
        if item.get("text_overflow_checked") is not True:
            errors += fail("text_overflow_checked must be true; unreviewed layouts cannot publish")
        if item.get("rendered_body_text") != item.get("body"):
            errors += fail("rendered_body_text must exactly match body; clipped or omitted copy cannot publish")
        if item.get("content_claim_checked") is not True:
            errors += fail("content_claim_checked must be true")
        if item.get("editorial_substance_checked") is not True:
            errors += fail("editorial_substance_checked must be true")
        headline = item.get("headline", "")
        body = item.get("body", "")
        if re.search(r"(?:\[\s*(?:…|\.{3})\s*\]|(?:…|\.{3}))\s*$", body) or re.search(r"\[\s*(?:…|\.{3})\s*\]", body):
            errors += fail("body contains a visibly truncated source excerpt")
        numbered_details = re.findall(r"\b\d+\.\s", body)
        numeric_promise = re.search(r"\b(?:all|top)\s+(\d+)\b|\b(\d+)\s+best\b", headline, re.I)
        if re.search(r"\b(?:ranked|ranking|top\s+\d+|best\s+\d+|\d+\s+best)\b", headline, re.I):
            required_details = int(next(group for group in numeric_promise.groups() if group)) if numeric_promise else 5
            if len(numbered_details) < required_details:
                errors += fail("ranking/list headline does not include the promised details")
        elif len(re.findall(r"\b\w+\b", body)) < 30:
            errors += fail("body is too thin to be informative")
    if not item.get("identity_checked"):
        errors += fail("identity_checked must be true")
    if item.get("photo_recency_checked") is not True:
        errors += fail("photo_recency_checked must be true")
    if item.get("source_photo_used") is not True:
        errors += fail("source_photo_used must be true; generic or invented visual scenes are not permitted")

    text_blob = json.dumps(item).casefold()
    if "automated" in text_blob:
        errors += fail("the word automated is not permitted in RapWire editorial assets")

    capture_date = item.get("photo_capture_date")
    if capture_date:
        try:
            captured = date.fromisoformat(capture_date)
            today = datetime.now().date()
            if captured.year < MIN_PHOTO_YEAR and item.get("story_type") != "throwback":
                errors += fail("photo is older than the allowed 2024-2026/current window")
            if captured > today:
                errors += fail("photo_capture_date cannot be in the future")
        except ValueError:
            errors += fail("photo_capture_date must use YYYY-MM-DD")

    if item.get("photo_event_relevance") not in {
        "event_specific", "same_campaign", "current_subject_portrait",
    }:
        errors += fail("photo_event_relevance is invalid")

    if item.get("audio_status") not in {"selected", "manual_required", "not_applicable"}:
        errors += fail("audio_status is invalid")
    if item.get("audio_status") == "not_applicable" and item.get("audio_track"):
        errors += fail("audio_track must be empty when audio_status is not_applicable")

    for handle_field in (
        "artist_instagram_handle", "lead_source_instagram_handle", "reporting_source_instagram_handle",
    ):
        handle = item.get(handle_field)
        if handle and not handle.startswith("@"):
            errors += fail(f"{handle_field} must begin with @")

    for url_field in ("source_urls", "visual_asset_source_urls"):
        for url in item.get(url_field, []):
            parsed = urlparse(url)
            if parsed.scheme != "https" or not parsed.netloc:
                errors += fail(f"invalid HTTPS URL in {url_field}: {url}")

    slides = item.get("slides", [])
    if not 2 <= len(slides) <= 10:
        errors += fail("carousel must contain 2-10 slides; use enough slides to show all copy without clipping")
    for relative in slides:
        path = root / relative
        if not path.exists():
            errors += fail(f"missing slide {relative}")
            continue
        with Image.open(path) as image:
            if image.size != (1080, 1350):
                errors += fail(f"{relative} must be 1080x1350, found {image.size}")

    if len(item.get("threads_text", "")) > 500:
        errors += fail("threads_text exceeds 500 characters")
    if item.get("visual_asset_rights") not in {
        "owned", "licensed", "press_use", "reuse_permitted", "source_post_repost",
        "CC BY 3.0", "CC BY 2.0", "CC BY-SA 4.0",
    }:
        errors += fail("visual_asset_rights is not an approved rights basis")

    if errors:
        return 1
    print(f"VALID: {item_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
