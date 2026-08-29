#!/usr/bin/env python3
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True
ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
QUEUE = ROOT / "queue"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def fallback_jpeg(jpg, headline="RAPWIRE 24/7", source=""):
    image = Image.new("RGB", (1080, 1350), (18, 19, 24))
    draw = ImageDraw.Draw(image)
    font_big = ImageFont.truetype(FONT, 70)
    font_small = ImageFont.truetype(FONT, 34)
    draw.rectangle((0, 0, 1080, 16), fill=(245, 202, 44))
    draw.text((58, 55), "RAPWIRE 24/7", font=font_big, fill=(248, 248, 246))
    draw.text((58, 180), headline[:70], font=font_small, fill=(245, 202, 44))
    if source:
        draw.text((58, 1230), f"SOURCE  @{source}", font=font_small, fill=(190, 192, 200))
    image.save(jpg, "JPEG", quality=94, optimize=True)


for png in list(MEDIA.glob("*.png")):
    jpg = png.with_suffix(".jpg")
    try:
        with Image.open(png) as image:
            image.convert("RGB").save(jpg, "JPEG", quality=94, optimize=True)
        png.unlink()
        print(f"Converted {png.name} -> {jpg.name}")
    except Exception as exc:
        # A damaged generated PNG must never stop the entire 24/7 pipeline.
        fallback_jpeg(jpg)
        try:
            png.unlink()
        except Exception:
            pass
        print(f"Fallback JPEG for damaged {png.name}: {exc}")

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
