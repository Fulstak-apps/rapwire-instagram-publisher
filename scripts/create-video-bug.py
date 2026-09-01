from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


out = Path("assets/rapwire247-video-bug.png")
width, height = 420, 92
cyan = "#00E5F0"
image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((2, 2, width - 3, height - 3), radius=18, fill="#07090C", outline=cyan, width=4)
font = ImageFont.truetype("/Library/Fonts/Anton/Anton-Regular.ttf", 48)
label = "RAPWIRE 24/7"
box = draw.textbbox((0, 0), label, font=font)
draw.text(((width - (box[2] - box[0])) / 2, (height - (box[3] - box[1])) / 2 - box[1]), label, font=font, fill=cyan)
out.parent.mkdir(parents=True, exist_ok=True)
image.save(out)
