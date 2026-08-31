#!/usr/bin/env python3
"""Queue the verified August 31 Rod Wave RIAA certification update."""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rapwire_layout", ROOT / "scripts" / "fallback-photo-post.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

primary = "https://www.instagram.com/p/DcuGumkI29x/"
riaa = "https://www.riaa.com/gold-platinum/?tab_active=default-award&se=Rod%20Wave"
complex_report = "https://www.complex.com/music/a/tracewilliamcowen/rod-wave-dont-look-down-projections"
headline = "ROD WAVE'S CATALOG GETS A MAJOR RIAA UPGRADE"
body = (
    "Say Cheese TV reports that Rod Wave received 59 new RIAA certifications. "
    "The RIAA database confirms a large August 31 batch across his catalog: 'Street Runner' reached 4x platinum; "
    "'Cold December' and 'Alone' reached 2x platinum; and 'Last Lap,' 'Checkmate' and 'Come See Me' reached platinum. "
    "Complex separately reported the new awards while noting that Don't Look Down is projected near 102,000 first-week units and could debut at No. 1; final chart results are still pending."
)

reference_image_url = layout.page_image(primary)
art_path = ROOT / "media" / "102-rod-wave-riaa-certifications-source-art.png"
image = Image.open(art_path).convert("RGB")

story = {"title": headline, "description": body}
story_id = "102-rod-wave-riaa-certifications"
headline, body, slides, story_path = layout.render(
    story_id,
    story,
    "Rod Wave",
    "@rodwave",
    "RAPWIRE ORIGINAL / SOURCE-GROUNDED",
    image,
    credit_prefix="ORIGINAL ART",
    hero_center_y=0.34,
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
    "editorial_lane": "rap_substantive",
    "headline": headline,
    "body": body,
    "rendered_body_text": body,
    "text_overflow_checked": True,
    "content_claim_checked": True,
    "editorial_substance_checked": True,
    "content_detail_count": 8,
    "content_format": "researched_news_context",
    "slides": [str(path.relative_to(ROOT)) for path in slides],
    "carousel_page_count": len(slides),
    "story": str(story_path.relative_to(ROOT)),
    "caption": f"{body}\n\nRod Wave (@rodwave)\n\nSources: Say Cheese TV, RIAA, Complex\nOriginal editorial art by RapWire; visual reference: Say Cheese TV / Instagram\n{primary}\n\n#RapWire247 #RodWave #HipHopNews",
    "threads_text": layout.threads_copy(headline, "Rod Wave", "@rodwave", body, "Say Cheese TV / RIAA / Complex"),
    "publish_to_threads": False,
    "featured_artist": "Rod Wave",
    "photo_subject": "Rod Wave",
    "artist_instagram_handle": "@rodwave",
    "artist_handle_verified": True,
    "artist_handle_verified_url": "https://www.instagram.com/rodwave/",
    "displayed_artist_label": "ROD WAVE  @rodwave",
    "identity_checked": True,
    "source_urls": [primary, riaa, complex_report],
    "source_handle": "saycheesetv",
    "source_policy_checked": True,
    "rap_relevance_checked": True,
    "source_url": primary,
    "source_title": "Rod Wave was just awarded 59 new certifications",
    "source_published_at": "2026-08-31T21:57:35Z",
    "source_image_url": reference_image_url,
    "source_image_role": "Factual visual reference for the materially redrawn original editorial illustration",
    "source_photo_used": True,
    "visual_asset_source_urls": [primary, complex_report, reference_image_url],
    "visual_asset_type": "ai_original_comic_from_source_reference",
    "visual_asset_rights": "owned",
    "fallback_real_photo": False,
    "ai_generated_art": True,
    "photo_capture_date": "2026-08-31",
    "photo_recency_checked": True,
    "photo_event_relevance": "current_subject_portrait",
    "photo_context_summary": "Current source-post image of Rod Wave was used as the factual reference for original award-wall editorial art.",
    "visual_safe_area_checked": True,
    "audio_status": "not_applicable",
    "audio_track": "",
    "publish_after": now.isoformat(),
}
(ROOT / "queue" / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
print(story_id)
