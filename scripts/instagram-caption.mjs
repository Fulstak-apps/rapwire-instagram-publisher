export const INSTAGRAM_CAPTION_LIMIT = 2200;

// Instagram rejects an otherwise valid upload when the caption is even one
// character too long. Keep one source per story before using a word-boundary
// fallback, and always retain the RapWire account footer.
export function fitInstagramCaption(value, limit = INSTAGRAM_CAPTION_LIMIT) {
  let caption = String(value || "").trim();
  if (caption.length <= limit) return caption;

  caption = caption.split("\n").map(line => {
    if (!/^sources?:\s*/i.test(line)) return line;
    return line.split(/\s+\|\s+/)[0];
  }).join("\n").trim();
  if (caption.length <= limit) return caption;

  const signature = /\n\n@rapwire247$/i.test(caption) ? "\n\n@Rapwire247" : "";
  const budget = Math.max(1, limit - signature.length - 1);
  const clipped = caption.slice(0, budget).replace(/\s+\S*$/, "").trimEnd();
  return `${clipped}…${signature}`;
}
