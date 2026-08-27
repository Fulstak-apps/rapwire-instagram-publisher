from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "media" / "mario-2024.png"
OUT1 = ROOT / "media" / "mario-40th-birthday-slide-1.jpg"
OUT2 = ROOT / "media" / "mario-40th-birthday-slide-2.jpg"
FONT_BOLD = "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf"
FONT_NARROW = "/usr/share/fonts/opentype/urw-base35/NimbusSansNarrow-Bold.otf"
CYAN, WHITE, BLACK, MUTED = "#00D9FF", "#F6F4F2", "#050505", "#89939A"
PARAGRAPH = (
    "@marioworldwide turned 40 on Thursday, August 27, marking the milestone with a first-party "
    "post about fatherhood and his seven-month-old son. The Baltimore singer first broke "
    "through as a teenager and built a two-decade R&B run around records including 'Just "
    "a Friend 2002' and 'Let Me Love You.' His birthday arrives while he is promoting the "
    "Mood Swings EP and new dates on The R&B Tour."
)


def fit_crop(image, size):
    target_width, target_height = size
    scale = max(target_width / image.width, target_height / image.height)
    resized = image.resize(
        (round(image.width * scale), round(image.height * scale)),
        Image.Resampling.LANCZOS,
    )
    left = max(0, (resized.width - target_width) // 2)
    top = max(0, (resized.height - target_height) // 2)
    return resized.crop((left, top, left + target_width, top + target_height))


def wordmark(draw, x_right=1026):
    font = ImageFont.truetype(FONT_BOLD, 44)
    rapwire_width = draw.textlength("RAPWIRE", font=font)
    number_width = draw.textlength("24/7", font=font)
    x = x_right - rapwire_width - 10 - number_width
    draw.text((x, 38), "RAPWIRE", font=font, fill=WHITE)
    draw.text((x + rapwire_width + 10, 38), "24/7", font=font, fill=CYAN)


def pill(draw, label, box):
    draw.rounded_rectangle(box, radius=13, fill="#07090A", outline=CYAN, width=3)
    font = ImageFont.truetype(FONT_BOLD, 25)
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    x = box[0] + (box[2] - box[0] - (right - left)) / 2 - left
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
source = ImageEnhance.Contrast(source).enhance(1.06)
cover = Image.new("RGB", (1080, 1350), BLACK)
cover.paste(fit_crop(source, (620, 1350)), (0, 0))
draw = ImageDraw.Draw(cover)
draw.rectangle((616, 0, 624, 1350), fill=CYAN)
draw.rectangle((624, 0, 1080, 1350), fill=BLACK)
wordmark(draw)
pill(draw, "MUSIC", (662, 154, 824, 214))
headline_font = ImageFont.truetype(FONT_NARROW, 72)
for line, y in (
    ("MARIO", 302),
    ("CELEBRATES", 388),
    ("40TH", 474),
    ("BIRTHDAY", 560),
):
    draw.text((660, y), line, font=headline_font, fill=WHITE, stroke_width=1, stroke_fill=WHITE)
draw.rectangle((662, 680, 1008, 686), fill=CYAN)
context_font = ImageFont.truetype(FONT_BOLD, 28)
draw.multiline_text(
    (662, 730),
    "TWO DECADES OF\nR&B RECORDS — AND\nA NEW CHAPTER AS A DAD.",
    font=context_font,
    fill=WHITE,
    spacing=12,
)
credit_font = ImageFont.truetype(FONT_BOLD, 15)
draw.multiline_text(
    (662, 1246),
    "PHOTO: WBLS / WIKIMEDIA COMMONS\nCC BY 3.0",
    font=credit_font,
    fill=CYAN,
    spacing=4,
)
cover.save(OUT1, quality=96, subsampling=0)

story = Image.new("RGB", (1080, 1350), BLACK)
draw = ImageDraw.Draw(story)
pill(draw, "THE STORY", (54, 42, 240, 102))
wordmark(draw)
draw.rectangle((54, 154, 1026, 160), fill=CYAN)
kicker = ImageFont.truetype(FONT_NARROW, 70)
draw.text((72, 218), "MARIO TURNS 40", font=kicker, fill=WHITE, stroke_width=1, stroke_fill=WHITE)
draw.rectangle((72, 306, 360, 312), fill=CYAN)
body_font = ImageFont.truetype(FONT_BOLD, 41)
lines = wrap(draw, PARAGRAPH, body_font, 920)
draw.multiline_text((72, 370), "\n".join(lines), font=body_font, fill=WHITE, spacing=18)
source_font = ImageFont.truetype(FONT_BOLD, 18)
draw.text((72, 1262), "SOURCES: MARIO • THE SHADE ROOM", font=source_font, fill=MUTED)
story.save(OUT2, quality=96, subsampling=0)

print(OUT1, OUT2, sep="\n")
