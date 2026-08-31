#!/usr/bin/env python3
"""Queue the verified August 31 Loe Shimmy and Drake video-shoot update."""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rapwire_layout", ROOT / "scripts" / "fallback-photo-post.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

primary = "https://www.instagram.com/p/DcuL3jLo4Bo/"
official_audio = "https://www.youtube.com/watch?v=UUkcFbDM0aw"
fader_interview = "https://www.thefader.com/2026/05/21/loe-shimmy-interview-drake-habibti-im-spent"
loe_profile_reference = "https://musicbrainz.org/artist/ed411d15-00f4-4e56-b264-94e0d2f64ffe"
headline = "LOE SHIMMY AND DRAKE FILM NEW MUSIC VIDEO"
body = (
    "Say Cheese TV reports Loe Shimmy and Drake were spotted filming a music video for 'I'm Spent' as fans gathered around the shoot. "
    "Official UMG release metadata confirms the collaboration arrived May 15 on Drake's HABIBTI and credits both artists. "
    "Loe Shimmy told The FADER he sent Drake the original song idea more than a year before its release. "
    "No official video release date has been announced."
)

reference_image_url = layout.page_image(primary)
art_path = ROOT / "media" / "104-loe-shimmy-drake-video-source-art.png"
image = Image.open(art_path).convert("RGB")

story = {"title": headline, "description": body}
story_id = "104-loe-shimmy-drake-video"
headline, body, slides, story_path = layout.render(
    story_id,
    story,
    "Loe Shimmy + Drake",
    "@loeshimmy",
    "RAPWIRE ORIGINAL / SOURCE-GROUNDED",
    image,
    credit_prefix="ORIGINAL ART",
    hero_center_y=0.43,
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
    "editorial_lane": "rap_culture",
    "headline": headline,
    "body": body,
    "rendered_body_text": body,
    "text_overflow_checked": True,
    "content_claim_checked": True,
    "editorial_substance_checked": True,
    "content_detail_count": 6,
    "content_format": "researched_news_context",
    "slides": [str(path.relative_to(ROOT)) for path in slides],
    "carousel_page_count": len(slides),
    "story": str(story_path.relative_to(ROOT)),
    "caption": f"{body}\n\nLoe Shimmy (@loeshimmy) + Drake (@champagnepapi)\n\nSources: Say Cheese TV, UMG/YouTube, The FADER\nOriginal editorial art by RapWire; visual reference: Say Cheese TV / Instagram\n{primary}\n\n#RapWire247 #LoeShimmy #Drake #HipHopNews",
    "threads_text": layout.threads_copy(headline, "Loe Shimmy + Drake", "@loeshimmy", body, "Say Cheese TV / UMG / The FADER"),
    "publish_to_threads": False,
    "featured_artist": "Loe Shimmy + Drake",
    "photo_subject": "Loe Shimmy + Drake",
    "artist_instagram_handle": "@loeshimmy",
    "artist_handle_verified": True,
    "artist_handle_verified_url": "https://www.instagram.com/loeshimmy/",
    "displayed_artist_label": "LOE SHIMMY + DRAKE  @loeshimmy",
    "additional_verified_artists": [
        {"name": "Drake", "handle": "@champagnepapi", "profile_url": "https://www.instagram.com/champagnepapi/"}
    ],
    "identity_checked": True,
    "source_urls": [primary, official_audio, fader_interview, loe_profile_reference],
    "source_handle": "saycheesetv",
    "source_policy_checked": True,
    "rap_relevance_checked": True,
    "source_url": primary,
    "source_title": "Loe Shimmy and Drake were spotted filming a video for I'm Spent",
    "source_published_at": "2026-08-31T22:42:30Z",
    "source_image_url": reference_image_url,
    "source_image_role": "Current source-post frame used as a factual reference for the materially redrawn original illustration",
    "source_photo_used": True,
    "visual_asset_source_urls": [primary, fader_interview, reference_image_url],
    "visual_asset_type": "ai_original_comic_from_source_reference",
    "visual_asset_rights": "owned",
    "fallback_real_photo": False,
    "ai_generated_art": True,
    "photo_capture_date": "2026-08-31",
    "photo_recency_checked": True,
    "photo_event_relevance": "event_specific",
    "photo_context_summary": "The current Say Cheese TV post and authenticated artist references were used to create original video-set editorial art.",
    "visual_safe_area_checked": True,
    "audio_status": "not_applicable",
    "audio_track": "",
    "publish_after": now.isoformat(),
}
(ROOT / "queue" / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
print(story_id)
