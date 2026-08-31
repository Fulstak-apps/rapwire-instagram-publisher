#!/usr/bin/env python3
"""Queue the verified August 31 Flacka testimony update."""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rapwire_layout", ROOT / "scripts" / "fallback-photo-post.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

primary = "https://www.instagram.com/p/Dct4ZEgSsi8/"
background = "https://thesource.com/2026/08/25/otf-vonni-otf-jam-and-flacka-to-testify-against-lil-durk-in-murder-for-hire-trial/"
indictment = "https://www.courthousenews.com/wp-content/uploads/2025/11/united-states-vs-banks-second-superseding-indictment.pdf"
headline = "FLACKA TESTIFIES ABOUT ALLEGED PAYMENT TALKS IN DURK TRIAL"
body = (
    "Trap Lore Ross reports that cooperating witness Keith 'Flacka' Jones testified about alleged payment discussions connected to the 2022 shooting at the center of Lil Durk's federal trial. "
    "Ross says Jones described being told that $1 million was available, later seeking payment, and ultimately receiving nothing; those statements are testimony and remain subject to cross-examination. "
    "The federal indictment separately alleges that money or music opportunities were promised in the charged murder-for-hire conspiracy, while earlier reporting identified Jones as a cooperating witness who pleaded guilty. "
    "Lil Durk has pleaded not guilty. The government's claims remain allegations, and he is presumed innocent unless proven guilty beyond a reasonable doubt."
)

reference_image_url = layout.page_image(primary)
art_path = ROOT / "media" / "101-flacka-testifies-about-alleged-payment-talks-in-du-source-art.png"
image = Image.open(art_path).convert("RGB")

story = {"title": headline, "description": body}
story_id = "101-flacka-testifies-about-alleged-payment-talks-in-du"
headline, body, slides, story_path = layout.render(
    story_id,
    story,
    "Trap Lore Ross",
    "@traploreross",
    "RAPWIRE ORIGINAL / SOURCE-GROUNDED",
    image,
    credit_prefix="ORIGINAL ART",
    hero_center_y=0.22,
)
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
    "content_detail_count": 5,
    "content_format": "researched_news_context",
    "slides": [str(path.relative_to(ROOT)) for path in slides],
    "carousel_page_count": len(slides),
    "story": str(story_path.relative_to(ROOT)),
    "caption": f"{body}\n\nTrap Lore Ross (@traploreross)\n\nSources: Trap Lore Ross, The Source, federal indictment\nOriginal editorial art by RapWire; visual reference: Trap Lore Ross / Instagram\n{primary}\n\n#RapWire247 #LilDurk #HipHopNews",
    "threads_text": layout.threads_copy(headline, "Trap Lore Ross", "@traploreross", body, "Trap Lore Ross / The Source"),
    "featured_artist": "Trap Lore Ross",
    "photo_subject": "Trap Lore Ross",
    "artist_instagram_handle": "@traploreross",
    "artist_handle_verified": True,
    "artist_handle_verified_url": "https://www.instagram.com/traploreross/",
    "displayed_artist_label": "TRAP LORE ROSS  @traploreross",
    "identity_checked": True,
    "source_urls": [primary, background, indictment],
    "source_handle": "traploreross",
    "source_policy_checked": True,
    "rap_relevance_checked": True,
    "source_url": primary,
    "source_title": "Durks shooter testified Durk finessed him. Promised a million dollars for the hit.",
    "source_published_at": "2026-08-31T19:56:00Z",
    "source_image_url": reference_image_url,
    "source_image_role": "Factual visual reference for the materially redrawn original editorial illustration",
    "source_photo_used": True,
    "visual_asset_source_urls": [primary, background, reference_image_url],
    "visual_asset_type": "ai_original_comic_from_source_reference",
    "visual_asset_rights": "owned",
    "fallback_real_photo": False,
    "ai_generated_art": True,
    "photo_capture_date": "2026-08-31",
    "photo_recency_checked": True,
    "photo_event_relevance": "event_specific",
    "photo_context_summary": "Current source-post image of Trap Lore Ross reporting from the Lil Durk federal trial was used as the factual reference for original art.",
    "visual_safe_area_checked": True,
    "audio_status": "not_applicable",
    "audio_track": "",
    "publish_after": now.isoformat(),
}
(ROOT / "queue" / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
print(story_id)
