#!/usr/bin/env python3
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
QUEUE = ROOT / "queue"

for png in MEDIA.glob("*.png"):
    jpg = png.with_suffix(".jpg")
    with Image.open(png) as image:
        image.convert("RGB").save(jpg, "JPEG", quality=94, optimize=True)
    png.unlink()
    print(f"Converted {png.name} -> {jpg.name}")

for path in QUEUE.glob("*.json"):
    try:
        item = json.loads(path.read_text())
    except Exception:
        continue
    changed = False
    slides = []
    for slide in item.get("slides", []):
        if slide.endswith(".png"):
            slide = slide[:-4] + ".jpg"
            changed = True
        slides.append(slide)
    if changed:
        item["slides"] = slides
        if isinstance(item.get("story"), str) and item["story"].endswith(".png"):
            item["story"] = item["story"][:-4] + ".jpg"
        path.write_text(json.dumps(item, indent=2) + "\n")
        print(f"Updated queue media references: {path.name}")
