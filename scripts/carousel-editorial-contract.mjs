const NUMBERED = index => new RegExp(`(?:^|\\n)\\s*${index}\\s*[.)]\\s+`, "m");
const URL = /https?:\/\/|\b(?:www\.)/i;
const PLACEHOLDER = /(?:five\s+(?:distinct|current)\s+stories|sources?\s+and\s+context|source\s+commentary)/i;

export function isOriginalEditorialCarousel(item = {}) {
  return item.type === "original_editorial_carousel";
}

// Editorial carousels are a separate product from ordinary photo/repost
// items.  Require their copy and brand-layout proof in the queue record, so a
// path to a markdown file, a generic summary, or an unbranded render can never
// reach a social publisher by accident.
export function carouselEditorialIssues(item = {}) {
  if (!isOriginalEditorialCarousel(item)) return [];
  const issues = [];
  const caption = String(item.caption || "").trim();
  if (!caption || /(?:^|\/)[^\n]+\.md(?:\s|$)/i.test(caption)) issues.push("caption must contain public copy, not a file path");
  if (URL.test(caption)) issues.push("caption must not include source links");
  if (PLACEHOLDER.test(caption) || PLACEHOLDER.test(String(item.headline || "")) || PLACEHOLDER.test(String(item.body || ""))) {
    issues.push("generic carousel framing is not allowed");
  }
  for (let index = 1; index <= 5; index += 1) {
    if (!NUMBERED(index).test(caption)) issues.push(`caption is missing numbered story ${index}`);
  }
  const copy = item.slide_editorial_copy;
  if (!Array.isArray(copy) || copy.length !== 5) {
    issues.push("five slide copy records are required");
  } else {
    copy.forEach((slide, offset) => {
      if (Number(slide?.slide) !== offset + 1) issues.push(`slide copy ${offset + 1} has an invalid slide number`);
      if (String(slide?.headline || "").trim().length < 4) issues.push(`slide ${offset + 1} needs a readable headline`);
      if (String(slide?.deck || "").trim().length < 28) issues.push(`slide ${offset + 1} needs a short on-art story blurb`);
      if (slide?.text_on_art !== true) issues.push(`slide ${offset + 1} must confirm headline and blurb were rendered on artwork`);
      if (slide?.top_banner !== false) issues.push(`slide ${offset + 1} must confirm no top banner was used`);
    });
  }
  const logo = item.brand_logo;
  if (!logo || logo.asset !== "assets/rapwire247-logo.png" || logo.position !== "bottom-left" || logo.transparent_background !== true || logo.backing_shape !== "none") {
    issues.push("official transparent RapWire logo proof is required");
  }
  if (item.carousel_visual_contract !== "rapwire-editorial-carousel-v1" || item.carousel_visual_qc !== true) {
    issues.push("carousel visual QA contract is missing");
  }
  return [...new Set(issues)];
}
