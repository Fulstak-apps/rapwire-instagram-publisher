import fs from "node:fs/promises";
import path from "node:path";

const token = process.env.INSTAGRAM_ACCESS_TOKEN;
const igUserId = process.env.INSTAGRAM_USER_ID;
const repository = process.env.GITHUB_REPOSITORY;
const refName = process.env.GITHUB_REF_NAME || "main";

if (!token || !igUserId || !repository) {
  throw new Error("Missing INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID, or GITHUB_REPOSITORY");
}

const apiBase = "https://graph.instagram.com";
const queueDir = "queue";
const files = (await fs.readdir(queueDir)).filter((name) => name.endsWith(".json")).sort();

async function post(endpoint, fields) {
  const body = new URLSearchParams({ ...fields, access_token: token });
  const response = await fetch(`${apiBase}/${igUserId}/${endpoint}`, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`${endpoint} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForContainer(containerId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const url = new URL(`${apiBase}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", token);
    const response = await fetch(url);
    const payload = await response.json();
    if (payload.status_code === "FINISHED") return;
    if (payload.status_code === "ERROR" || payload.status_code === "EXPIRED") {
      throw new Error(`Container ${containerId} failed: ${JSON.stringify(payload)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`Container ${containerId} did not finish in time`);
}

for (const file of files) {
  const itemPath = path.join(queueDir, file);
  const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
  if (item.status !== "ready") continue;
  if (!Array.isArray(item.slides) || item.slides.length < 2) {
    throw new Error(`${file} must contain at least two slides`);
  }

  const childIds = [];
  for (const slide of item.slides) {
    const imageUrl = `https://raw.githubusercontent.com/${repository}/${refName}/${slide}`;
    const child = await post("media", { image_url: imageUrl, is_carousel_item: "true" });
    await waitForContainer(child.id);
    childIds.push(child.id);
  }

  const carousel = await post("media", {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: item.caption
  });
  await waitForContainer(carousel.id);
  const published = await post("media_publish", { creation_id: carousel.id });

  item.status = "published";
  item.instagram_media_id = published.id;
  item.published_at = new Date().toISOString();
  await fs.writeFile(itemPath, `${JSON.stringify(item, null, 2)}\n`);
  console.log(`Published ${file}: ${published.id}`);
}
