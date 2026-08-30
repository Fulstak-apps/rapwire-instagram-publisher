import fs from "node:fs/promises";
import path from "node:path";

const dir = "queue";
for (const file of await fs.readdir(dir)) {
  if (!file.endsWith(".json")) continue;
  const filePath = path.join(dir, file);
  const item = JSON.parse(await fs.readFile(filePath, "utf8"));
  const validSlideCount = Array.isArray(item.slides) && item.slides.length >= 2 && item.slides.length <= 3;
  const sourceGrounded = item.source_photo_used === true && typeof item.source_image_url === "string" && /^https?:\/\//i.test(item.source_image_url);
  const approvedFallback = item.fallback_real_photo === true
    && item.visual_asset_type === "source_photo"
    && item.visual_asset_rights === "source_post_repost"
    && item.photo_recency_checked === true;
  if (item.status === "ready" && ((!approvedFallback && item.ai_generated_art !== true) || !sourceGrounded || !validSlideCount)) {
    item.status = "paused";
    item.pause_reason = "Visual blocked: RapWire requires source-grounded AI art or an approved credited real-photo fallback, plus a two- or three-slide carousel";
    await fs.writeFile(filePath, `${JSON.stringify(item, null, 2)}\n`);
    console.log(`Blocked legacy/non-AI queue item: ${file}`);
  }
}
