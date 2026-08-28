from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "media" / "jeezy-2014-original.jpg"
OUT1 = ROOT / "media" / "jeezy-vegas-extension-slide-1.jpg"
OUT2 = ROOT / "media" / "jeezy-vegas-extension-slide-2.jpg"
FONT_BOLD = "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf"
FONT_NARROW = "/usr/share/fonts/opentype/urw-base35/NimbusSansNarrow-Bold.otf"
CYAN, WHITE, BLACK, MUTED = "#00D9FF", "#F6F4F2", "#050505", "#89939A"
PARAGRAPH = (
    "@jeezy added nine final dates to his Legend of the Snowman Las Vegas residency, running "
    "November 6 through New Year's Eve at PH Live. At the August 22 show, Clark County "
    "Commissioner William McCurdy II presented him with the Key to the Las Vegas Strip as "
    "LeBron James joined the moment. The official schedule lists the new November and "
    "December performances."
)


def wordmark(draw):
    font = ImageFont.truetype(FONT_BOLD, 48)
    rapwire_width = draw.textlength("RAPWIRE", font=font)
    number_width = draw.textlength("24/7", font=font)
    x = 1026 - rapwire_width - 12 - number_width
    draw.text((x, 38), "RAPWIRE", font=font, fill=WHITE)
    draw.text((x + rapwire_width + 12, 38), "24/7", font=font, fill=CYAN)


def pill(draw, label, right):
    box = (54, 42, right, 102)
    draw.rounded_rectangle(box, radius=13, fill="#07090A", outline=CYAN, width=3)
    font = ImageFont.truetype(FONT_BOLD, 26)
    left, top, text_right, bottom = draw.textbbox((0, 0), label, font=font)
    x = box[0] + (box[2] - box[0] - (text_right - left)) / 2 - left
    y = box[1] + (box[3] - box[1] - (bottom - top)) / 2 - top
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
source = ImageEnhance.Contrast(source).enhance(1.08)
source = source.resize((1080, 720), Image.Resampling.LANCZOS)
cover = Image.new("RGB", (1080, 1350), BLACK)
cover.paste(source, (0, 130))
draw = ImageDraw.Draw(cover)
draw.rectangle((0, 0, 1080, 130), fill=BLACK)
draw.rectangle((0, 850, 1080, 1350), fill=BLACK)
draw.rectangle((0, 846, 1080, 852), fill=CYAN)
pill(draw, "MUSIC", 214)
wordmark(draw)
headline_font = ImageFont.truetype(FONT_NARROW, 92)
for line, y in (
    ("JEEZY EXTENDS", 892),
    ("VEGAS RESIDENCY", 990),
    ("THROUGH NYE", 1088),
):
    draw.text((54, y), line, font=headline_font, fill=WHITE, stroke_width=2, stroke_fill=WHITE)
credit_font = ImageFont.truetype(FONT_BOLD, 16)
draw.text(
    (56, 1298),
    "PHOTO: CZR-E / THE COME UP SHOW, CC BY 2.0",
    font=credit_font,
    fill=CYAN,
)
cover.save(OUT1, quality=96, subsampling=0)

story = Image.new("RGB", (1080, 1350), BLACK)
draw = ImageDraw.Draw(story)
pill(draw, "THE STORY", 240)
wordmark(draw)
draw.rectangle((54, 154, 1026, 160), fill=CYAN)
kicker = ImageFont.truetype(FONT_NARROW, 70)
draw.text((72, 218), "NINE MORE VEGAS DATES", font=kicker, fill=WHITE, stroke_width=1, stroke_fill=WHITE)
draw.rectangle((72, 306, 448, 312), fill=CYAN)
body_font = ImageFont.truetype(FONT_BOLD, 41)
lines = wrap(draw, PARAGRAPH, body_font, 920)
draw.multiline_text((72, 370), "\n".join(lines), font=body_font, fill=WHITE, spacing=18)
source_font = ImageFont.truetype(FONT_BOLD, 18)
draw.text((72, 1262), "SOURCES: JEEZY • LEGEND OF THE SNOWMAN", font=source_font, fill=MUTED)
story.save(OUT2, quality=96, subsampling=0)

print(OUT1, OUT2, sep="\n")
