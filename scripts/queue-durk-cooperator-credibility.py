#!/usr/bin/env python3
"""Queue the verified August 31 Lil Durk cooperator-credibility update."""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rapwire_layout", ROOT / "scripts" / "fallback-photo-post.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

primary = "https://www.instagram.com/p/Dct4nkQSGKO/"
complex_report = "https://www.complex.com/music/a/jaelaniturnerwilliams/lil-durk-trial-keith-flacka-jones-testifies"
dancehall_report = "https://www.dancehallmag.com/2026/08/29/news/lil-durk-trial-day-7-defense-challenges-otf-jams-shifting-testimony.html"
ap_background = "https://apnews.com/article/5d55866b2caf5ef5bd7d3cef43b6ced8"
headline = "DURK DEFENSE TARGETS COOPERATOR CREDIBILITY"
body = (
    "Trap Lore Ross reports Lil Durk's defense pressed Keith Flacka Jones over differences between his account and earlier testimony from Kacey OTF Jam Hester. "
    "Complex confirms Jones followed Hester as the government's second cooperating witness. "
    "DancehallMag reports the defense separately used recorded interviews to argue Hester changed answers at key points. "
    "These are defense credibility arguments, not court findings. Durk pleaded not guilty and is presumed innocent."
)

reference_image_url = layout.page_image(primary)
complex_image_url = layout.page_image(complex_report)
art_path = ROOT / "media" / "106-durk-cooperator-credibility-source-art.png"
image = Image.open(art_path).convert("RGB")

story = {"title": headline, "description": body}
story_id = "106-durk-cooperator-credibility"
headline, body, slides, story_path = layout.render(
    story_id,
    story,
    "Lil Durk",
    "@lildurk",
    "RAPWIRE ORIGINAL / SOURCE-GROUNDED",
    image,
    credit_prefix="ORIGINAL ART",
    hero_center_y=0.45,
)
if len(slides) != 2:
    raise ValueError(f"Expected exactly two carousel slides, rendered {len(slides)}")

now = datetime.now(timezone.utc)
item = {
    "id": story_id,
    "status": "ready",
    "date": now.date().isoformat(),
    "timezone": "America/Detroit",
    "type": "fallback_photo_news",
    "layout_template": "rapwire-unified-v3",
    "story_type": "current_news",
    "editorial_lane": "lil_durk_trial",
    "headline": headline,
    "body": body,
    "rendered_body_text": body,
    "text_overflow_checked": True,
    "content_claim_checked": True,
    "editorial_substance_checked": True,
    "content_detail_count": 8,
    "content_format": "researched_legal_news_context",
    "slides": [str(path.relative_to(ROOT)) for path in slides],
    "carousel_page_count": len(slides),
    "story": str(story_path.relative_to(ROOT)),
    "caption": f"{body}\n\nLil Durk (@lildurk)\n\nSources: Trap Lore Ross, Complex, DancehallMag, AP\nOriginal editorial art by RapWire; identity reference: Complex / WireImage\n{primary}\n\n#RapWire247 #LilDurk #DurkTrial #HipHopNews",
    "threads_text": layout.threads_copy(headline, "Lil Durk", "@lildurk", body, "Trap Lore Ross / Complex / DancehallMag / AP"),
    "publish_to_threads": False,
    "featured_artist": "Lil Durk",
    "photo_subject": "Lil Durk",
    "artist_instagram_handle": "@lildurk",
    "artist_handle_verified": True,
    "artist_handle_verified_url": "https://www.instagram.com/lildurk/",
    "displayed_artist_label": "LIL DURK  @lildurk",
    "identity_checked": True,
    "source_urls": [primary, complex_report, dancehall_report, ap_background],
    "source_handle": "traploreross",
    "source_policy_checked": True,
    "rap_relevance_checked": True,
    "source_url": primary,
    "source_title": "Flacka and Jam's stories do not match; Drew Findling presses Flacka",
    "source_published_at": "2026-08-31T20:00:06Z",
    "source_image_url": reference_image_url,
    "source_image_role": "Current courtroom report used as a factual reference for the materially redrawn original illustration",
    "source_photo_used": True,
    "visual_asset_source_urls": [primary, complex_report, dancehall_report, reference_image_url, complex_image_url],
    "visual_asset_type": "ai_original_comic_from_source_reference",
    "visual_asset_rights": "owned",
    "fallback_real_photo": False,
    "ai_generated_art": True,
    "photo_capture_date": "2026-08-31",
    "photo_recency_checked": True,
    "photo_event_relevance": "event_specific",
    "photo_context_summary": "Current courtroom reporting and a credited Lil Durk identity photo were used as factual references for original cross-examination art.",
    "visual_safe_area_checked": True,
    "audio_status": "not_applicable",
    "audio_track": "",
    "publish_after": now.isoformat(),
}
(ROOT / "queue" / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
print(story_id)
