import fs from "node:fs/promises";
import path from "node:path";

const instagramToken = process.env.INSTAGRAM_ACCESS_TOKEN;
const instagramUserId = process.env.INSTAGRAM_USER_ID;
const threadsToken = process.env.THREADS_ACCESS_TOKEN;
const threadsUserId = process.env.THREADS_USER_ID;
const repository = process.env.GITHUB_REPOSITORY;
const refName = process.env.GITHUB_REF_NAME || "main";

if (!instagramToken || !instagramUserId || !repository) {
  throw new Error("Missing INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID, or GITHUB_REPOSITORY");
}

const instagramBase = "https://graph.instagram.com";
const threadsBase = "https://graph.threads.net/v1.0";
const queueDir = "queue";
const files = (await fs.readdir(queueDir)).filter((name) => name.endsWith(".json")).sort();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const mediaUrl = (relativePath) => `https://raw.githubusercontent.com/${repository}/${refName}/${relativePath}`;

async function save(itemPath, item) {
  await fs.writeFile(itemPath, `${JSON.stringify(item, null, 2)}\n`);
}

async function instagramPost(endpoint, fields) {
  const body = new URLSearchParams({ ...fields, access_token: instagramToken });
  const response = await fetch(`${instagramBase}/${instagramUserId}/${endpoint}`, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`${endpoint} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForInstagramContainer(containerId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const url = new URL(`${instagramBase}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", instagramToken);
    const payload = await (await fetch(url)).json();
    if (payload.status_code === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(payload.status_code)) {
      throw new Error(`Instagram container ${containerId} failed: ${JSON.stringify(payload)}`);
    }
    await sleep(10_000);
  }
  throw new Error(`Instagram container ${containerId} did not finish in time`);
}

async function threadsPost(endpoint, fields) {
  const body = new URLSearchParams({ ...fields, access_token: threadsToken });
  const response = await fetch(`${threadsBase}/${threadsUserId}/${endpoint}`, { method: "POST", body });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`Threads ${endpoint} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForThreadsContainer(containerId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const url = new URL(`${threadsBase}/${containerId}`);
    url.searchParams.set("fields", "status,error_message");
    url.searchParams.set("access_token", threadsToken);
    const payload = await (await fetch(url)).json();
    if (payload.status === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(payload.status)) {
      throw new Error(`Threads container ${containerId} failed: ${JSON.stringify(payload)}`);
    }
    await sleep(10_000);
  }
  throw new Error(`Threads container ${containerId} did not finish in time`);
}

async function publishInstagramFeed(item) {
  const childIds = [];
  for (const slide of item.slides) {
    const child = await instagramPost("media", { image_url: mediaUrl(slide), is_carousel_item: "true" });
    await waitForInstagramContainer(child.id);
    childIds.push(child.id);
  }
  const carousel = await instagramPost("media", {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: item.caption
  });
  await waitForInstagramContainer(carousel.id);
  return instagramPost("media_publish", { creation_id: carousel.id });
}

async function publishInstagramStory(item) {
  const story = await instagramPost("media", { media_type: "STORIES", image_url: mediaUrl(item.story) });
  await waitForInstagramContainer(story.id);
  return instagramPost("media_publish", { creation_id: story.id });
}

async function publishThreadsCarousel(item) {
  const children = [];
  for (const slide of item.slides) {
    const child = await threadsPost("threads", {
      media_type: "IMAGE",
      image_url: mediaUrl(slide),
      is_carousel_item: "true"
    });
    await waitForThreadsContainer(child.id);
    children.push(child.id);
  }
  const carousel = await threadsPost("threads", {
    media_type: "CAROUSEL",
    children: children.join(","),
    text: item.threads_text || item.caption
  });
  await waitForThreadsContainer(carousel.id);
  return threadsPost("threads_publish", { creation_id: carousel.id });
}

for (const file of files) {
  const itemPath = path.join(queueDir, file);
  const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
  if (!Array.isArray(item.slides) || item.slides.length < 2) continue;
  if (item.status === "paused") continue;

  if (item.status === "ready") {
    const published = await publishInstagramFeed(item);
    item.status = "published";
    item.instagram_media_id = published.id;
    item.published_at = new Date().toISOString();
    await save(itemPath, item);
    console.log(`Published Instagram feed ${file}: ${published.id}`);
  }

  if (item.story && !item.instagram_story_status) {
    try {
      const published = await publishInstagramStory(item);
      item.instagram_story_status = "published";
      item.instagram_story_media_id = published.id;
      item.instagram_story_published_at = new Date().toISOString();
      console.log(`Published Instagram Story ${file}: ${published.id}`);
    } catch (error) {
      item.instagram_story_status = "failed";
      item.instagram_story_error = error.message;
      console.error(`Instagram Story failed for ${file}: ${error.message}`);
    }
    await save(itemPath, item);
  }

  if (threadsToken && threadsUserId && !item.threads_status) {
    try {
      const published = await publishThreadsCarousel(item);
      item.threads_status = "published";
      item.threads_media_id = published.id;
      item.threads_published_at = new Date().toISOString();
      console.log(`Published Threads carousel ${file}: ${published.id}`);
    } catch (error) {
      item.threads_status = "failed";
      item.threads_error = error.message;
      console.error(`Threads failed for ${file}: ${error.message}`);
    }
    await save(itemPath, item);
  }
}
