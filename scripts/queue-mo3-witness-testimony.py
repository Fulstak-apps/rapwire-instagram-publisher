#!/usr/bin/env python3
"""Queue the verified August 31 MO3 trial testimony update."""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rapwire_layout", ROOT / "scripts" / "fallback-photo-post.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

primary = "https://www.instagram.com/p/Dct0fMyFUjI/"
kdfw = "https://www.yahoo.com/news/videos/witness-claims-kewon-white-confessed-185936805.html"
kera = "https://www.keranews.org/news/2026-08-26/witnesses-to-mo3-killing-in-dallas-testify-yella-beezy-murder-trial"
identity_reference = "https://www.flaunt.com/blog/mo3"
headline = "WITNESS TESTIFIES ABOUT ALLEGED MO3 SHOOTING CONFESSION"
body = (
    "No Jumper reports that cooperating witness Cedric Bradley testified Kewon White told him about MO3's 2020 freeway shooting and expected payment afterward. "
    "Fox 4/KDFW independently reports Bradley told jurors he grew up with White and claimed White described the killing. "
    "KERA says prosecutors allege White was the gunman in a murder-for-hire plot, while the defense argues the state's case has gaps. "
    "White has pleaded not guilty and is presumed innocent unless proven guilty."
)

reference_image_url = layout.page_image(primary)
art_path = ROOT / "media" / "103-mo3-witness-testimony-source-art.png"
image = Image.open(art_path).convert("RGB")

story = {"title": headline, "description": body}
story_id = "103-mo3-witness-testimony"
headline, body, slides, story_path = layout.render(
    story_id,
    story,
    "MO3",
    "@hotboymo3",
    "RAPWIRE ORIGINAL / SOURCE-GROUNDED",
    image,
    credit_prefix="ORIGINAL ART",
    hero_center_y=0.28,
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
    "content_detail_count": 7,
    "content_format": "researched_news_context",
    "slides": [str(path.relative_to(ROOT)) for path in slides],
    "carousel_page_count": len(slides),
    "story": str(story_path.relative_to(ROOT)),
    "caption": f"{body}\n\nMO3 (@hotboymo3)\n\nSources: No Jumper, Fox 4/KDFW, KERA\nOriginal editorial art by RapWire; visual references: No Jumper / Instagram and Flaunt\n{primary}\n\n#RapWire247 #MO3 #HipHopNews",
    "threads_text": layout.threads_copy(headline, "MO3", "@hotboymo3", body, "No Jumper / Fox 4 / KERA"),
    "publish_to_threads": False,
    "featured_artist": "MO3",
    "photo_subject": "MO3",
    "artist_instagram_handle": "@hotboymo3",
    "artist_handle_verified": True,
    "artist_handle_verified_url": "https://www.instagram.com/hotboymo3/",
    "displayed_artist_label": "MO3  @hotboymo3",
    "identity_checked": True,
    "source_urls": [primary, kdfw, kera, identity_reference],
    "source_handle": "nojumper",
    "source_policy_checked": True,
    "rap_relevance_checked": True,
    "source_url": primary,
    "source_title": "A cooperating witness took the stand against Kewon White in the MO3 murder trial",
    "source_published_at": "2026-08-31T19:18:12Z",
    "source_image_url": reference_image_url,
    "source_image_role": "Current courtroom frame used as a factual reference for the materially redrawn original illustration",
    "source_photo_used": True,
    "visual_asset_source_urls": [primary, identity_reference, reference_image_url],
    "visual_asset_type": "ai_original_comic_from_source_reference",
    "visual_asset_rights": "owned",
    "fallback_real_photo": False,
    "ai_generated_art": True,
    "photo_capture_date": "2026-08-31",
    "photo_recency_checked": True,
    "photo_event_relevance": "event_specific",
    "photo_context_summary": "The current No Jumper courtroom frame and an authenticated MO3 editorial portrait were used as factual references for original courtroom art.",
    "visual_safe_area_checked": True,
    "audio_status": "not_applicable",
    "audio_track": "",
    "publish_after": now.isoformat(),
}
(ROOT / "queue" / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
print(story_id)
