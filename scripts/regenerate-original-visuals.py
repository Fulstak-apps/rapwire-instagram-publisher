#!/usr/bin/env python3
"""Replace source-blog photos with owned RapWire comic visuals for every ready story."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "queue"

spec = importlib.util.spec_from_file_location("ingest_narro", ROOT / "scripts" / "ingest-narro.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

changed = 0
for path in sorted(QUEUE.glob("*.json")):
    try:
        item = json.loads(path.read_text())
    except Exception:
        continue
    if item.get("status") != "ready":
        continue
    headline = item.get("headline", item.get("source_title", "RapWire News"))
    body = item.get("body", "")
    source = item.get("source", "rapwire")
    story_id = path.stem
    feed1, feed2, story, _ = module.render_graphics(
        story_id,
        source,
        headline,
        body,
        None,  # IMPORTANT: never reuse the source blog's photograph.
    )
    item["visual_asset_type"] = "original_graphic"
    item["visual_asset_rights"] = "owned"
    item["photo_event_relevance"] = "same_campaign"
    item["photo_context_summary"] = "Original RapWire comic illustration generated from the current story topic; no source-blog photo reused."
    item["source_image_url"] = ""
    item["media_urls"] = [str(feed1.relative_to(ROOT)), str(feed2.relative_to(ROOT))]
    item["story_media_url"] = str(story.relative_to(ROOT))
    item["slides"] = [str(feed1.relative_to(ROOT)), str(feed2.relative_to(ROOT))]
    item["story"] = str(story.relative_to(ROOT))
    path.write_text(json.dumps(item, indent=2) + "\n")
    changed += 1

print(f"Original visual refresh: regenerated {changed} ready story/stories.")
