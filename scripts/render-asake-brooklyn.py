from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "media" / "asake-source.png"
OUT1 = ROOT / "media" / "asake-brooklyn-slide-1.jpg"
OUT2 = ROOT / "media" / "asake-brooklyn-slide-2.jpg"
STORY = ROOT / "media" / "asake-brooklyn-story.jpg"
FONT_BOLD = "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf"
FONT_NARROW = "/usr/share/fonts/opentype/urw-base35/NimbusSansNarrow-Bold.otf"
CYAN, WHITE, BLACK, MUTED = "#00D9FF", "#F6F4F2", "#050505", "#89939A"
PARAGRAPH = (
    "@mrmoney brings the In God We Trust World Tour to Brooklyn's Barclays Center tonight, "
    "August 26, with Uncle Waffles joining the bill. The 8:30 p.m. show puts Asake's current "
    "M$NEY era on one of New York City's biggest arena stages."
)

def fit_crop(image, size):
    tw, th = size
    scale = max(tw / image.width, th / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - tw) // 2)
    top = max(0, (resized.height - th) // 2)
    return resized.crop((left, top, left + tw, top + th))

def wordmark(draw):
    font = ImageFont.truetype(FONT_BOLD, 48)
    rw = draw.textlength("RAPWIRE", font=font)
    nw = draw.textlength("24/7", font=font)
    x = 1026 - rw - 12 - nw
    draw.text((x, 38), "RAPWIRE", font=font, fill=WHITE)
    draw.text((x + rw + 12, 38), "24/7", font=font, fill=CYAN)

def pill(draw, label, right):
    box = (54, 42, right, 102)
    draw.rounded_rectangle(box, radius=13, fill="#07090A", outline=CYAN, width=3)
    font = ImageFont.truetype(FONT_BOLD, 26)
    l, t, r, b = draw.textbbox((0, 0), label, font=font)
    x = box[0] + (box[2] - box[0] - (r-l)) / 2 - l
    y = box[1] + (box[3] - box[1] - (b-t)) / 2 - t
    draw.text((x, y), label, font=font, fill=CYAN)

def wrap(draw, text, font, width):
    lines, current = [], ""
    for word in text.split():
        trial = word if not current else f"{current} {word}"
        if draw.textlength(trial, font=font) <= width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines

source = Image.open(SOURCE).convert("RGB")
source = ImageEnhance.Contrast(source).enhance(1.10)
cover = Image.new("RGB", (1080, 1350), BLACK)
cover.paste(fit_crop(source, (1080, 876)), (0, 0))
draw = ImageDraw.Draw(cover)
draw.rectangle((0, 872, 1080, 876), fill=CYAN)
draw.rectangle((0, 876, 1080, 1350), fill=BLACK)
pill(draw, "MUSIC", 200)
wordmark(draw)
headline_font = ImageFont.truetype(FONT_NARROW, 110)
for line, y in (("ASAKE BRINGS", 908), ("IN GOD WE TRUST", 1014), ("TO BROOKLYN", 1120)):
    draw.text((54, y), line, font=headline_font, fill=WHITE, stroke_width=2, stroke_fill=WHITE)
credit_font = ImageFont.truetype(FONT_BOLD, 18)
draw.text((56, 1298), "PHOTO: MENSAH MEMORIES / CC BY 3.0", font=credit_font, fill=CYAN)
cover.save(OUT1, quality=96, subsampling=0)

story = Image.new("RGB", (1080, 1350), BLACK)
draw = ImageDraw.Draw(story)
pill(draw, "THE STORY", 240)
wordmark(draw)
draw.rectangle((54, 154, 1026, 160), fill=CYAN)
kicker = ImageFont.truetype(FONT_NARROW, 78)
draw.text((72, 218), "BROOKLYN TONIGHT", font=kicker, fill=WHITE, stroke_width=1, stroke_fill=WHITE)
draw.rectangle((72, 316, 352, 322), fill=CYAN)
body_font = ImageFont.truetype(FONT_BOLD, 46)
lines = wrap(draw, PARAGRAPH, body_font, 920)
draw.multiline_text((72, 382), "\n".join(lines), font=body_font, fill=WHITE, spacing=18)
source_font = ImageFont.truetype(FONT_BOLD, 18)
draw.text((72, 1262), "SOURCE: @BARCLAYSCENTER • LIVE NATION", font=source_font, fill=MUTED)
story.save(OUT2, quality=96, subsampling=0)

story_image = Image.new("RGB", (1080, 1920), BLACK)
story_image.paste(cover, (0, 285))
story_image.save(STORY, quality=95, subsampling=0)
print(OUT1, OUT2, STORY, sep="\n")
