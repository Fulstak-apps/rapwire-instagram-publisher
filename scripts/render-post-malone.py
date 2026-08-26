from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "media" / "post-malone-source.jpg"
OUT1 = ROOT / "media" / "post-malone-august-26-slide-1.jpg"
OUT2 = ROOT / "media" / "post-malone-august-26-slide-2.jpg"
STORY = ROOT / "media" / "post-malone-august-26-story.jpg"
FONT_BOLD = "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf"
FONT_NARROW = "/usr/share/fonts/opentype/urw-base35/NimbusSansNarrow-Bold.otf"
CYAN, WHITE, BLACK, MUTED = "#00D9FF", "#F6F4F2", "#050505", "#89939A"
PARAGRAPH = (
    "Post Malone's 2016 mixtape August 26 is officially available on streaming for the first time, "
    "marking the project's 10th anniversary. The 10-track tape features Larry June, 2 Chainz, "
    "Jeremih, Lil Yachty, Jaden Smith and Teo. A first official vinyl pressing is also part of the anniversary release."
)

def fit_crop(image, size):
    target_w, target_h = size
    scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - target_w) // 2)
    return resized.crop((left, 0, left + target_w, target_h))

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
    left, top, text_right, bottom = draw.textbbox((0, 0), label, font=font)
    width, height = text_right - left, bottom - top
    x = box[0] + (box[2] - box[0] - width) / 2 - left
    y = box[1] + (box[3] - box[1] - height) / 2 - top
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
    if current: lines.append(current)
    return lines

source = Image.open(SOURCE).convert("RGB")
source = ImageEnhance.Contrast(source).enhance(1.08)
cover = Image.new("RGB", (1080, 1350), BLACK)
cover.paste(fit_crop(source, (1080, 876)), (0, 0))
draw = ImageDraw.Draw(cover)
draw.rectangle((0, 872, 1080, 876), fill=CYAN)
draw.rectangle((0, 876, 1080, 1350), fill=BLACK)
pill(draw, "MUSIC", 200)
wordmark(draw)
headline_font = ImageFont.truetype(FONT_NARROW, 116)
for line, y in (("POST MALONE PUTS", 908), ("AUGUST 26 ON", 1018), ("STREAMING", 1128)):
    draw.text((54, y), line, font=headline_font, fill=WHITE, stroke_width=2, stroke_fill=WHITE)
credit_font = ImageFont.truetype(FONT_BOLD, 18)
draw.text((56, 1298), "PHOTO: THE COME UP SHOW / CC BY 2.0", font=credit_font, fill=CYAN)
cover.save(OUT1, quality=96, subsampling=0)

story = Image.new("RGB", (1080, 1350), BLACK)
draw = ImageDraw.Draw(story)
pill(draw, "THE STORY", 240)
wordmark(draw)
draw.rectangle((54, 154, 1026, 160), fill=CYAN)
kicker = ImageFont.truetype(FONT_NARROW, 78)
draw.text((72, 218), "AUGUST 26 RETURNS", font=kicker, fill=WHITE, stroke_width=1, stroke_fill=WHITE)
draw.rectangle((72, 316, 352, 322), fill=CYAN)
body_font = ImageFont.truetype(FONT_BOLD, 46)
lines = wrap(draw, PARAGRAPH, body_font, 920)
draw.multiline_text((72, 382), "\n".join(lines), font=body_font, fill=WHITE, spacing=18)
source_font = ImageFont.truetype(FONT_BOLD, 18)
draw.text((72, 1262), "SOURCE: POST MALONE OFFICIAL SITE • SPOTIFY", font=source_font, fill=MUTED)
story.save(OUT2, quality=96, subsampling=0)

story_image = Image.new("RGB", (1080, 1920), BLACK)
scaled = cover.resize((1080, 1350), Image.Resampling.LANCZOS)
story_image.paste(scaled, (0, 285))
story_image.save(STORY, quality=95, subsampling=0)
print(OUT1, OUT2, STORY, sep="\n")
