#!/usr/bin/env python3
"""Queue the verified August 31 Meek Mill AI-learning update."""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rapwire_layout", ROOT / "scripts" / "fallback-photo-post.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

primary = "https://www.instagram.com/p/DcuLUkDuOGZ/"
complex_report = "https://www.complex.com/music/a/backwoodsaltar/meek-mill-ai-tool-learning-tweet"
inquirer_report = "https://www.inquirer.com/arts/meek-mill-linkedin-account-20260327.html"
headline = "MEEK MILL SAYS AI IS HIS BEST TEACHER"
body = (
    "Meek Mill wrote on X that 'nothing teaches me better than AI,' saying it explains questions he has asked people for years. "
    "Complex confirmed the August 31 post and reported the Philadelphia rapper has repeatedly championed AI tools. "
    "The Philadelphia Inquirer previously documented that he uses Claude to organize music and business plans and has discussed AI classes in underserved communities. "
)

reference_image_url = layout.page_image(primary)
complex_image_url = layout.page_image(complex_report)
art_path = ROOT / "media" / "105-meek-mill-ai-learning-source-art.png"
image = Image.open(art_path).convert("RGB")

story = {"title": headline, "description": body}
story_id = "105-meek-mill-ai-learning"
headline, body, slides, story_path = layout.render(
    story_id,
    story,
    "Meek Mill",
    "@meekmill",
    "RAPWIRE ORIGINAL / SOURCE-GROUNDED",
    image,
    credit_prefix="ORIGINAL ART",
    hero_center_y=0.42,
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
    "content_detail_count": 7,
    "content_format": "researched_news_context",
    "slides": [str(path.relative_to(ROOT)) for path in slides],
    "carousel_page_count": len(slides),
    "story": str(story_path.relative_to(ROOT)),
    "caption": f"{body}\n\nMeek Mill (@meekmill)\n\nSources: The Shade Room, Complex, The Philadelphia Inquirer\nOriginal editorial art by RapWire; identity reference: Complex / Getty Images\n{primary}\n\n#RapWire247 #MeekMill #HipHopNews #AI",
    "threads_text": layout.threads_copy(headline, "Meek Mill", "@meekmill", body, "The Shade Room / Complex / The Philadelphia Inquirer"),
    "publish_to_threads": False,
    "featured_artist": "Meek Mill",
    "photo_subject": "Meek Mill",
    "artist_instagram_handle": "@meekmill",
    "artist_handle_verified": True,
    "artist_handle_verified_url": "https://www.instagram.com/meekmill/",
    "displayed_artist_label": "MEEK MILL  @meekmill",
    "identity_checked": True,
    "source_urls": [primary, complex_report, inquirer_report],
    "source_handle": "theshaderoom",
    "source_policy_checked": True,
    "rap_relevance_checked": True,
    "source_url": primary,
    "source_title": "Meek Mill says AI has been teaching him more than humans",
    "source_published_at": "2026-08-31T22:39:04Z",
    "source_image_url": reference_image_url,
    "source_image_role": "Current source-post graphic used to confirm the topic; the final visual uses materially redrawn original art",
    "source_photo_used": True,
    "visual_asset_source_urls": [primary, complex_report, inquirer_report, reference_image_url, complex_image_url],
    "visual_asset_type": "ai_original_comic_from_source_reference",
    "visual_asset_rights": "owned",
    "fallback_real_photo": False,
    "ai_generated_art": True,
    "photo_capture_date": "2026-08-31",
    "photo_recency_checked": True,
    "photo_event_relevance": "current_subject_portrait",
    "photo_context_summary": "A current verified report and a credited Complex/Getty Meek Mill portrait were used as factual references for original studio-and-AI editorial art.",
    "visual_safe_area_checked": True,
    "audio_status": "not_applicable",
    "audio_track": "",
    "publish_after": now.isoformat(),
}
(ROOT / "queue" / f"{story_id}.json").write_text(json.dumps(item, indent=2) + "\n")
print(story_id)
