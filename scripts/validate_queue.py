#!/usr/bin/env python3
import json
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image


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
        "status",
        "date",
        "timezone",
        "headline",
        "body",
        "slides",
        "caption",
        "threads_text",
        "featured_artist",
        "photo_subject",
        "audio_artist",
        "audio_status",
        "identity_checked",
        "source_urls",
        "visual_asset_source_urls",
        "visual_asset_rights",
        "photo_capture_date",
        "photo_recency_checked",
        "photo_event_relevance",
        "photo_context_summary",
        "publish_after",
    ]
    for field in required:
        if field not in item or item[field] in ("", [], None):
            if field not in {"audio_track"}:
                errors += fail(f"missing required field {field}")

    if item.get("status") != "ready":
        errors += fail("status must be ready")
    if item.get("timezone") != "America/Detroit":
        errors += fail("timezone must be America/Detroit")
    if item.get("body") and not item.get("caption", "").startswith(item["body"]):
        errors += fail("caption must begin with the exact slide-2 body")
    if not item.get("identity_checked"):
        errors += fail("identity_checked must be true")
    if item.get("photo_recency_checked") is not True:
        errors += fail("photo_recency_checked must be true")

    capture_date = item.get("photo_capture_date")
    if capture_date:
        try:
            captured = date.fromisoformat(capture_date)
            age_days = (datetime.now().date() - captured).days
            if age_days < -7:
                errors += fail("photo_capture_date cannot be in the future")
            if age_days > 366:
                errors += fail("photo is older than 12 months")
        except ValueError:
            errors += fail("photo_capture_date must use YYYY-MM-DD")

    if item.get("photo_event_relevance") not in {
        "event_specific",
        "same_campaign",
        "current_subject_portrait",
    }:
        errors += fail("photo_event_relevance is invalid")

    featured = item.get("featured_artist", "").casefold()
    if item.get("photo_subject", "").casefold() != featured:
        errors += fail("photo_subject must match featured_artist")
    if item.get("audio_artist", "").casefold() != featured:
        errors += fail("audio_artist must match featured_artist")
    if item.get("audio_status") not in {"selected", "manual_required", "not_applicable"}:
        errors += fail("audio_status is invalid")
    if item.get("audio_status") == "not_applicable" and item.get("audio_track"):
        errors += fail("audio_track must be empty when audio_status is not_applicable")

    for handle_field in (
        "artist_instagram_handle",
        "lead_source_instagram_handle",
        "reporting_source_instagram_handle",
    ):
        handle = item.get(handle_field)
        if handle and not handle.startswith("@"):
            errors += fail(f"{handle_field} must begin with @")

    if not item.get("artist_instagram_handle") and not item.get(
        "subject_handle_verification"
    ):
        errors += fail(
            "artist_instagram_handle is required unless a documented no-handle verification is provided"
        )

    for url_field in ("source_urls", "visual_asset_source_urls"):
        for url in item.get(url_field, []):
            parsed = urlparse(url)
            if parsed.scheme != "https" or not parsed.netloc:
                errors += fail(f"invalid HTTPS URL in {url_field}: {url}")

    slides = item.get("slides", [])
    if len(slides) != 2:
        errors += fail("exactly two carousel slides are required")
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
        "owned",
        "licensed",
        "press_use",
        "reuse_permitted",
        "CC BY 3.0",
        "CC BY 2.0",
        "CC BY-SA 4.0",
    }:
        errors += fail("visual_asset_rights is not an approved rights basis")

    if errors:
        return 1
    print(f"VALID: {item_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
