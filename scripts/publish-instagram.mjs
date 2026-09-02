import fs from "node:fs/promises";
import path from "node:path";

const instagramToken = process.env.INSTAGRAM_ACCESS_TOKEN;
const instagramUserId = process.env.INSTAGRAM_USER_ID;
const threadsToken = process.env.THREADS_ACCESS_TOKEN;
const threadsUserId = process.env.THREADS_USER_ID;
const publishInstagramStories = process.env.PUBLISH_INSTAGRAM_STORIES === "true";
const repository = process.env.GITHUB_REPOSITORY;
const refName = process.env.GITHUB_REF_NAME || "main";

if (!instagramToken || !instagramUserId || !threadsToken || !threadsUserId || !repository) {
  throw new Error("Missing Instagram/Threads credentials or GITHUB_REPOSITORY; RapWire requires both platforms");
}

const instagramBase = "https://graph.instagram.com";
const threadsBase = "https://graph.threads.net/v1.0";
const queueDir = "queue";
const logsDir = "logs";
const attemptsLog = path.join(logsDir, "publish-attempts.jsonl");
const cooldownPath = path.join(logsDir, "instagram-cooldown.json");
let cooldown = JSON.parse(await fs.readFile(cooldownPath, "utf8").catch(error => {
  if (error.code === "ENOENT") return "{}";
  throw error;
}));
if (Date.parse(cooldown.until || "") > Date.now()) {
  console.log(`Instagram rate-limit cooldown until ${cooldown.until}; saved uploads retained.`);
  process.exit(0);
}

async function checkInstagramRateLimit(response, payload) {
  if (response.status !== 429 && ![4, 17, 32, 613].includes(payload.error?.code)) return;
  const previousRecent = Date.now() - Date.parse(cooldown.detected_at || "") < 24 * 60 * 60_000;
  const strikes = previousRecent ? Number(cooldown.strikes || 0) + 1 : 1;
  const retryAfter = response.headers.get("retry-after");
  const serverDelay = Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
  const delay = Math.max(serverDelay, Math.min(240, 30 * 2 ** (strikes - 1)) * 60_000);
  cooldown = { detected_at: new Date().toISOString(), until: new Date(Date.now() + delay).toISOString(), strikes, reason: "Instagram application request limit" };
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(cooldownPath, JSON.stringify(cooldown, null, 2) + "\n");
  throw new Error(`Instagram rate limited; all requests deferred until ${cooldown.until}`);
}

function assertInstagramAvailable() {
  if (Date.parse(cooldown.until || "") > Date.now()) throw new Error(`Instagram cooling down until ${cooldown.until}`);
}
const queueNames = (await fs.readdir(queueDir)).filter((name) => name.endsWith(".json")).sort();
const queueRecords = await Promise.all(queueNames.map(async (name) => ({
  name,
  item: JSON.parse(await fs.readFile(path.join(queueDir, name), "utf8"))
})));
const files = queueRecords
  .sort((left, right) => {
    const readyDelta = Number(right.item.status === "ready") - Number(left.item.status === "ready");
    if (readyDelta) return readyDelta;
    const priorityDelta = Number(right.item.publish_priority || 0) - Number(left.item.publish_priority || 0);
    return priorityDelta || left.name.localeCompare(right.name);
  })
  .map((record) => record.name);
// Respect the workflow's pacing limit. The newsroom may prepare a batch, but
// only the configured number of feed posts should go live in one cycle.
const maxFeedPostsPerRun = Math.max(1, Number(process.env.MAX_FEED_POSTS_PER_RUN || 3));
const maxFeedPostsPerRollingDay = 96;
let feedPostsPublishedThisRun = 0;
let olderStoryAttemptsThisRun = 0;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requestTimeoutMs = 90_000;
const signature = "@Rapwire247";
const mediaUrl = (relativePath) => `https://raw.githubusercontent.com/${repository}/${refName}/${relativePath}`;

async function logAttempt(event) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(attemptsLog, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

function signedCaption(value, item = {}) {
  const source = String(item.source_handle || "").replace(/^@/, "");
  const sourceLine = /^[A-Za-z0-9_.]+$/.test(source) ? `\n@${source}` : "";
  return String(value || "")
    .trim()
    .replace(/(?:\n\n)?Rap\s*Wire 24\/7\.?\s*\n@Rapwire247(?:\s*\n@[A-Za-z0-9_.]+)?\s*$/i, "")
    .replace(/(?:\n\n)?RapWire 24\/7\.?\s*$/i, "")
    .replace(/(?:\n\n)?@Rapwire247\s*$/i, "")
    .trim() + `\n\nRap Wire 24/7\n${signature}${sourceLine}`;
}

function slideUrl(item, index) {
  const remote = Array.isArray(item.media_urls) ? item.media_urls[index] : "";
  return remote && /^https?:\/\//i.test(remote) ? remote : mediaUrl(item.slides[index]);
}

function storyUrl(item) {
  const remote = item.story_media_url || "";
  return remote && /^https?:\/\//i.test(remote) ? remote : mediaUrl(item.story);
}

function videoUrl(item) {
  const remote = item.video_url || "";
  return remote && /^https?:\/\//i.test(remote) ? remote : mediaUrl(item.video);
}

function hasPublishableVisual(item) {
  if (item.visual_asset_type === "original_graphic" && item.visual_asset_rights === "owned") return true;
  if (item.visual_asset_type === "source_photo" && item.visual_asset_rights === "source_post_repost") {
    return Boolean(item.story || item.slides?.length);
  }
  if (item.photo_recency_checked !== true) return false;
  if (!["event_specific", "same_campaign", "current_subject_portrait"].includes(item.photo_event_relevance)) return false;
  if (!item.photo_context_summary || typeof item.photo_context_summary !== "string") return false;
  const capturedAt = Date.parse(`${item.photo_capture_date}T00:00:00Z`);
  return Number.isFinite(capturedAt) && capturedAt <= Date.now();
}

async function save(itemPath, item) {
  await fs.writeFile(itemPath, `${JSON.stringify(item, null, 2)}\n`);
}

async function instagramPost(endpoint, fields) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertInstagramAvailable();
    const body = new URLSearchParams({ ...fields, access_token: instagramToken });
    const response = await fetch(`${instagramBase}/${instagramUserId}/${endpoint}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const payload = await response.json();
    await checkInstagramRateLimit(response, payload);
    if (response.ok && !payload.error) return payload;
    const mediaNotReady = endpoint === "media_publish"
      && payload.error?.code === 9007
      && payload.error?.error_subcode === 2207027;
    const retryable = (payload.error?.code === 1 || mediaNotReady) && attempt < 2;
    if (!retryable) throw new Error(`${endpoint} failed: ${JSON.stringify(payload)}`);
    await sleep((attempt + 1) * 15_000);
  }
}

async function waitForInstagramContainer(containerId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertInstagramAvailable();
    const url = new URL(`${instagramBase}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", instagramToken);
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    const payload = await response.json();
    await checkInstagramRateLimit(response, payload);
    if (!response.ok || payload.error) throw new Error(`Instagram status check failed: ${JSON.stringify(payload)}`);
    if (payload.status_code === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(payload.status_code)) {
      throw new Error(`Instagram container ${containerId} failed: ${JSON.stringify(payload)}`);
    }
    await sleep(60_000);
  }
  throw new Error(`Instagram container ${containerId} did not finish in time`);
}

async function threadsPost(endpoint, fields) {
  if (!threadsToken || !threadsUserId) throw new Error("Missing THREADS_ACCESS_TOKEN or THREADS_USER_ID");
  const body = new URLSearchParams({ ...fields, access_token: threadsToken });
  const response = await fetch(`${threadsBase}/${threadsUserId}/${endpoint}`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`Threads ${endpoint} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForThreadsContainer(containerId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const url = new URL(`${threadsBase}/${containerId}`);
    url.searchParams.set("fields", "status,error_message");
    url.searchParams.set("access_token", threadsToken);
    const payload = await (await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) })).json();
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
  for (let index = 0; index < item.slides.length; index += 1) {
    const child = await instagramPost("media", { image_url: slideUrl(item, index), is_carousel_item: "true" });
    await waitForInstagramContainer(child.id);
    childIds.push(child.id);
  }
  const carousel = await instagramPost("media", {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: signedCaption(item.caption, item)
  });
  await waitForInstagramContainer(carousel.id);
  return instagramPost("media_publish", { creation_id: carousel.id });
}

async function prepareInstagramReel(item, itemPath) {
  if (!item.instagram_container_id) {
    const reel = await instagramPost("media", {
    media_type: "REELS",
    video_url: videoUrl(item),
    caption: signedCaption(item.caption, item),
    share_to_feed: "true"
    });
    item.instagram_container_id = reel.id;
    item.instagram_container_created_at = new Date().toISOString();
    await save(itemPath, item);
  }
}

async function publishInstagramReel(item, itemPath) {
  assertInstagramAvailable();
  if (!item.instagram_container_id) return null;
  if (Date.now() - Date.parse(item.instagram_container_checked_at || 0) < 60_000) return null;
  const url = new URL(`${instagramBase}/${item.instagram_container_id}`);
  url.searchParams.set("fields", "status_code,status");
  url.searchParams.set("access_token", instagramToken);
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  const payload = await response.json();
  await checkInstagramRateLimit(response, payload);
  if (!response.ok || payload.error) throw new Error(`Instagram processing check failed: ${JSON.stringify(payload)}`);
  item.instagram_container_checked_at = new Date().toISOString();
  item.instagram_container_status = payload.status_code;
  await save(itemPath, item);
  if (payload.status_code === "FINISHED") {
    if (item.instagram_publish_requested_at) {
      item.status = "media_refresh_required";
      throw new Error("Previous publish result is uncertain; reconcile before retrying to prevent duplicates");
    }
    item.instagram_publish_requested_at = new Date().toISOString();
    await save(itemPath, item);
    return instagramPost("media_publish", { creation_id: item.instagram_container_id });
  }
  if (["ERROR", "EXPIRED", "PUBLISHED"].includes(payload.status_code)
    || Date.now() - Date.parse(item.instagram_container_created_at) >= 15 * 60_000) {
    item.status = "media_refresh_required";
    throw new Error(`Upload needs review after processing status ${payload.status_code}: ${payload.status || "15-minute grace window reached"}`);
  }
  console.log(`Waiting for Instagram processing: ${item.id} (${item.instagram_container_id}); continuing queue`);
  return null;
}

async function publishInstagramStory(item) {
  // Image/carousel stories use the dedicated 1080x1920 asset. Video reposts use
  // the same playable MP4 so every post also appears in Instagram Stories.
  const isVideoItem = item.content_type === "video";
  if (!isVideoItem && !item.story) throw new Error("Story asset missing");
  const story = await instagramPost("media", isVideoItem
    ? { media_type: "STORIES", video_url: videoUrl(item) }
    : { media_type: "STORIES", image_url: storyUrl(item) });
  await waitForInstagramContainer(story.id);
  return instagramPost("media_publish", { creation_id: story.id });
}

async function publishThreadsCarousel(item) {
  const children = [];
  for (let index = 0; index < item.slides.length; index += 1) {
    const child = await threadsPost("threads", {
      media_type: "IMAGE",
      image_url: slideUrl(item, index),
      is_carousel_item: "true"
    });
    await waitForThreadsContainer(child.id);
    children.push(child.id);
  }
  const carousel = await threadsPost("threads", {
    media_type: "CAROUSEL",
    children: children.join(","),
    text: signedCaption(item.threads_text || item.caption, item)
  });
  await waitForThreadsContainer(carousel.id);
  return threadsPost("threads_publish", { creation_id: carousel.id });
}

async function publishThreadsVideo(item) {
  const video = await threadsPost("threads", {
    media_type: "VIDEO",
    video_url: videoUrl(item),
    text: signedCaption(item.threads_text || item.caption, item)
  });
  await waitForThreadsContainer(video.id);
  return threadsPost("threads_publish", { creation_id: video.id });
}

function contentPromiseIsKept(item) {
  const headline = String(item.headline || "");
  const body = String(item.body || "");
  const words = body.trim().split(/\s+/).filter(Boolean);
  // Reposts are playable clips, not newsroom explainers.  They intentionally
  // use short captions, so applying the 45-word explainer requirement here
  // silently prevents every otherwise-valid video from publishing.
  if (item.content_type === "video") {
    return words.length >= 8 && /[.!?]/.test(body);
  }
  const numberedDetails = body.match(/\b\d+\.\s/g) || [];
  if (/(?:\[\s*(?:…|\.{3})\s*\]|(?:…|\.{3}))\s*$/.test(body) || /\[\s*(?:…|\.{3})\s*\]/.test(body)) {
    return false;
  }
  const numericPromise = headline.match(/\b(?:all|top)\s+(\d+)\b|\b(\d+)\s+best\b/i);
  if (/\b(?:ranked|ranking|top\s+\d+|best\s+\d+|\d+\s+best)\b/i.test(headline)) {
    const required = numericPromise ? Number(numericPromise[1] || numericPromise[2]) : 5;
    return numberedDetails.length >= required;
  }
  const completeSentences = body.match(/[^.!?]+[.!?]+/g) || [];
  return words.length >= 45 && completeSentences.length >= 2;
}

const rollingDayStart = Date.now() - 24 * 60 * 60 * 1000;
let feedPostsPublishedInRollingDay = 0;
for (const file of files) {
  const item = JSON.parse(await fs.readFile(path.join(queueDir, file), "utf8"));
  if (item.status === "published" && item.instagram_media_id && item.published_at && Date.parse(item.published_at) >= rollingDayStart) {
    feedPostsPublishedInRollingDay += 1;
  }
}

// Fill at most three processing slots concurrently. Existing uploads retain
// their slots across runs so slow processing cannot create an upload pileup.
const processingCount = queueRecords.filter(({ item }) => item.status === "ready"
  && item.content_type === "video" && item.instagram_container_id).length;
const uploadSlots = Math.max(0, Math.min(3 - processingCount, maxFeedPostsPerRollingDay - feedPostsPublishedInRollingDay));
const uploadCandidates = files.map(name => queueRecords.find(record => record.name === name))
  .filter(({ item }) => item.status === "ready" && item.content_type === "video"
    && !item.instagram_container_id && String(item.video || "").endsWith(".mp4")
    && (!item.publish_after || Date.parse(item.publish_after) <= Date.now())
    && item.layout_template === "rapwire-video-grid-safe-v1"
    && item.text_overflow_checked === true && item.rendered_body_text === item.body
    && item.content_claim_checked === true && item.editorial_substance_checked === true
    && contentPromiseIsKept(item) && item.source_policy_checked === true && item.rap_relevance_checked === true
    && (!/^(124|125|126|127|128|129)-/.test(item.id || "") || item.logo_position === "bottom-left"))
  .slice(0, uploadSlots);
await Promise.all(uploadCandidates.map(async ({ name, item }) => {
  try {
    await prepareInstagramReel(item, path.join(queueDir, name));
    console.log(`Prepared upload ${item.id}: ${item.instagram_container_id}`);
  } catch (error) {
    await logAttempt({ file: name, id: item.id, platform: "instagram", status: "failed", error: error.message });
  }
}));

for (const file of files) {
  const itemPath = path.join(queueDir, file);
  const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
  const wasReady = item.status === "ready";
  const legacyRightLogo = /^(124|125|126|127|128|129)-/.test(item.id || "") && item.logo_position !== "bottom-left";
  if (item.content_type === "video" && legacyRightLogo) {
    await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "bottom_left_logo_rebuild_required" });
    continue;
  }
  const isVideoItem = item.content_type === "video";
  if (!isVideoItem && (!Array.isArray(item.slides) || item.slides.length < 2 || item.slides.length > 10)) {
    console.error(`Skipped ${file}: RapWire carousels require 2-10 complete, readable slides`);
    await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "invalid_carousel_slide_count" });
    continue;
  }
  if (isVideoItem && (!item.video || !String(item.video).endsWith(".mp4"))) {
    console.error(`Skipped ${file}: RapWire video item is missing its MP4 asset`);
    await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "missing_video_asset" });
    continue;
  }
  if (item.status === "paused" || item.status === "media_refresh_required") continue;
  if (item.publish_after && Date.parse(item.publish_after) > Date.now()) continue;

  if (item.status === "ready") {
    // Keep captions consistent even if an item was queued before the current
    // identity rule was introduced.
    const normalizedCaption = signedCaption(item.caption, item);
    const normalizedThreadsText = signedCaption(item.threads_text || item.caption, item);
    if (item.caption !== normalizedCaption || item.threads_text !== normalizedThreadsText) {
      item.caption = normalizedCaption;
      item.threads_text = normalizedThreadsText;
      await save(itemPath, item);
    }
    if ((!isVideoItem && item.layout_template !== "rapwire-unified-v3")
      || (isVideoItem && item.layout_template !== "rapwire-video-grid-safe-v1")) {
      console.error(`Skipped ${file}: asset does not use the locked RapWire template`);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "invalid_layout_template" });
      continue;
    }
    if (item.text_overflow_checked !== true || item.rendered_body_text !== item.body) {
      console.error(`Skipped ${file}: copy completeness/overflow verification failed`);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "copy_or_overflow_check_failed" });
      continue;
    }
    if (item.content_claim_checked !== true || item.editorial_substance_checked !== true || !contentPromiseIsKept(item)) {
      console.error(`Skipped ${file}: headline promise or editorial substance check failed`);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "editorial_substance_check_failed" });
      continue;
    }
    if (item.source_policy_checked !== true || item.rap_relevance_checked !== true) {
      console.error(`Skipped ${file}: approved-source or rap-only verification is missing`);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "source_or_rap_relevance_check_failed" });
      continue;
    }
    if (!isVideoItem && !hasPublishableVisual(item)) {
      console.error(`Skipped ${file}: current/relevant visual verification is missing`);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "skipped", reason: "visual_verification_missing" });
      continue;
    }
    if (feedPostsPublishedThisRun >= maxFeedPostsPerRun) {
      await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "run_feed_limit_reached" });
      continue;
    }
    if (feedPostsPublishedInRollingDay >= maxFeedPostsPerRollingDay) {
      await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "rolling_day_feed_limit_reached" });
      continue;
    }
    let published;
    try {
      published = isVideoItem ? await publishInstagramReel(item, itemPath) : await publishInstagramFeed(item);
    } catch (error) {
      item.instagram_error = error.message;
      await save(itemPath, item);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "failed", error: error.message });
      console.error(`Instagram failed for ${file}: ${error.message}`);
      continue;
    }
    if (!published) continue;
    item.status = "published";
    item.instagram_media_id = published.id;
    item.published_at = new Date().toISOString();
    await logAttempt({ file, id: item.id, platform: "instagram", status: "published", media_id: published.id, content_type: item.content_type || "carousel" });
    await save(itemPath, item);
    feedPostsPublishedThisRun += 1;
    feedPostsPublishedInRollingDay += 1;
    console.log(`Published Instagram feed ${file}: ${published.id}`);
  }

  if (item.status !== "published") continue;

  const retryTransientStoryFailure = item.instagram_story_status === "failed"
    && /(?:Media ID is not available|2207027)/i.test(String(item.instagram_story_error || ""));
  const storyPending = !item.instagram_story_status || item.instagram_story_status === "pending";
  if (publishInstagramStories && (item.story || isVideoItem) && (storyPending || retryTransientStoryFailure)
    && (wasReady || olderStoryAttemptsThisRun < 1)) {
    if (!wasReady) olderStoryAttemptsThisRun += 1;
    try {
      const published = await publishInstagramStory(item);
      item.instagram_story_status = "published";
      item.instagram_story_media_id = published.id;
      item.instagram_story_published_at = new Date().toISOString();
      delete item.instagram_story_error;
      await logAttempt({ file, id: item.id, platform: "instagram_story", status: "published", media_id: published.id });
      console.log(`Published Instagram Story ${file}: ${published.id}`);
    } catch (error) {
      item.instagram_story_status = "failed";
      item.instagram_story_error = error.message;
      await logAttempt({ file, id: item.id, platform: "instagram_story", status: "failed", error: error.message });
      console.error(`Instagram Story failed for ${file}: ${error.message}`);
    }
    await save(itemPath, item);
  }

  if (!item.threads_story_status) {
    item.threads_story_status = "not_supported";
    item.threads_story_note = "Threads API publishing supports posts, video posts, image posts, carousels, and replies; a separate Story format is not available through the current publisher.";
    await logAttempt({ file, id: item.id, platform: "threads_story", status: "not_supported", reason: "no_threads_story_publish_endpoint" });
    await save(itemPath, item);
  }

  // Threads is required for every published RapWire carousel. Honor old queue items that
  // were previously marked Instagram-only so they can be backfilled automatically.
  if (item.rap_relevance_checked === true
    && (!item.threads_status || item.threads_status === "pending" || item.threads_status === "failed" || item.threads_status === "skipped_for_instagram_only_post")) {
    try {
      const published = isVideoItem ? await publishThreadsVideo(item) : await publishThreadsCarousel(item);
      item.threads_status = "published";
      item.threads_media_id = published.id;
      item.threads_published_at = new Date().toISOString();
      delete item.threads_error;
      await logAttempt({ file, id: item.id, platform: "threads", status: "published", media_id: published.id });
      console.log(`Published Threads carousel ${file}: ${published.id}`);
    } catch (error) {
      item.threads_status = "failed";
      item.threads_error = error.message;
      await logAttempt({ file, id: item.id, platform: "threads", status: "failed", error: error.message });
      console.error(`Threads failed for ${file}: ${error.message}`);
    }
    await save(itemPath, item);
  }
}
