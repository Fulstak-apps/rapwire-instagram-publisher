import fs from "node:fs/promises";
import path from "node:path";

const dir = "queue";
for (const file of await fs.readdir(dir)) {
  if (!file.endsWith(".json")) continue;
  const filePath = path.join(dir, file);
  const item = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (item.status === "ready" && item.ai_generated_art !== true) {
    item.status = "paused";
    item.pause_reason = "Non-AI visual asset blocked by RapWire visual policy";
    await fs.writeFile(filePath, `${JSON.stringify(item, null, 2)}\n`);
    console.log(`Blocked legacy/non-AI queue item: ${file}`);
  }
}
