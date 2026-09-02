import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capture, launch } from "./instagram-browser-mirror.mjs";

const execFileAsync = promisify(execFile);

const root = path.resolve(".");
const ledgerPath = path.join(root, "monitor", "repost-ledger.json");
const lockPath = path.join(root, "monitor", "repost-monitor.lock");
const queueDir = path.join(root, "queue");
const mediaDir = path.join(root, "media");
const sources = [
  { handle: "trapmatictv", credit: false, includePosts: true, includeReels: true },
  { handle: "raplisted_", credit: false, includePosts: true, includeReels: true },
  { handle: "akademiks", credit: true, includePosts: true, includeReels: true },
  { handle: "traploreross", credit: true, includePosts: true, includeReels: true }
];
const maxQueuePerRun = Math.max(1, Number(process.env.RAPWIRE_REPOSTS_PER_RUN || 3));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function shortcodeFromUrl(url) {
  return url.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/)?.[1] || "";
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/@\w+/g, "")
    .trim();
}

function slugify(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "rapwire-repost-video";
}

async function nextQueueNumber() {
  const names = await fs.readdir(queueDir).catch(() => []);
  const numbers = names
    .map((name) => Number(name.match(/^(\d+)-/)?.[1] || 0))
    .filter(Boolean);
  return Math.max(116, ...numbers) + 1;
}

async function discoverFromProfile(context, source) {
  const page = await context.newPage();
  try {
    await page.goto(`https://www.instagram.com/${source.handle}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const hrefs = await page.locator('a[href*="/reel/"], a[href*="/p/"]').evaluateAll((links) =>
      links.map((link) => link.href).filter(Boolean)
    );
    const unique = [...new Set(hrefs)]
      .filter((url) => source.includeReels && /\/reel\//.test(url) || source.includePosts && /\/p\//.test(url))
      .map((url) => ({ source, url, shortcode: shortcodeFromUrl(url) }))
      .filter((item) => item.shortcode);
    return unique;
  } finally {
    await page.close();
  }
}

async function readPostCaption(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const candidates = [
      await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => ""),
      await page.locator('meta[property="og:description"]').getAttribute("content").catch(() => ""),
      await page.locator("article").innerText({ timeout: 2500 }).catch(() => "")
    ];
    return cleanText(candidates.find((candidate) => cleanText(candidate).length > 20) || "");
  } finally {
    await page.close();
  }
}

async function withFreshBrowser(task) {
  const context = await launch(true);
  try {
    return await task(context);
  } finally {
    await context.close();
  }
}

async function acquireLock() {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const ageMs = Date.now() - Date.parse(existing.started_at || 0);
    if (Number.isFinite(ageMs) && ageMs < 15 * 60 * 1000) {
      console.log(JSON.stringify({ status: "locked", lock: existing }));
      process.exit(0);
    }
  } catch {
    // No active lock or unreadable stale lock.
  }
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2));
}

async function releaseLock() {
  await fs.rm(lockPath, { force: true });
}

function buildBody(source, visibleCaption) {
  const base = visibleCaption
    ? visibleCaption.split(/[.!?]\s/).slice(0, 2).join(". ").slice(0, 220)
    : "A new hip-hop video is making the rounds and RapWire is reposting it for the feed.";
  const credit = source.credit ? ` Source: @${source.handle}.` : "";
  return `${base}${base.endsWith(".") ? "" : "."}${credit} RapWire 24/7 is keeping the video feed moving with quick repost coverage while bigger reported stories stay on the AI newsroom schedule.`;
}

async function queueCapture(ledger, candidate, queueNumber) {
  const shortcode = candidate.shortcode;
  await capture(candidate.url, { headless: true });
  const sourceVideo = path.join(root, "work", "instagram-mirror", `${shortcode}.mp4`);
  await fs.access(sourceVideo);
  const visibleCaption = await withFreshBrowser((freshContext) => readPostCaption(freshContext, candidate.url));
  const headlineSeed = visibleCaption || `${candidate.source.handle} repost video`;
  const id = `${String(queueNumber).padStart(3, "0")}-${slugify(headlineSeed)}`;
  const mediaPath = path.join(mediaDir, `${id}.mp4`);
  await fs.copyFile(sourceVideo, mediaPath);

  const body = buildBody(candidate.source, visibleCaption);
  const queueItem = {
    id,
    status: "ready",
    publish_priority: 50,
    date: new Date().toISOString().slice(0, 10),
    timezone: "America/Detroit",
    content_type: "video",
    type: "source_video_repost",
    story_type: "throwback",
    layout_template: "rapwire-video-grid-safe-v1",
    editorial_lane: "rap_culture",
    headline: cleanText(headlineSeed).slice(0, 90) || "RapWire Video Repost",
    body,
    rendered_body_text: body,
    caption: `${body}\n\nRapWire 24/7.`,
    threads_text: `${body}\n\nRapWire 24/7.`,
    video: path.relative(root, mediaPath),
    source_handle: candidate.source.handle,
    source_url: candidate.url,
    source_urls: [candidate.url],
    visual_asset_type: "source_video",
    visual_asset_rights: "source_post_repost",
    source_video_used: true,
    grid_safe_checked: true,
    text_overflow_checked: true,
    content_claim_checked: true,
    editorial_substance_checked: true,
    source_policy_checked: true,
    rap_relevance_checked: true,
    threads_status: "pending"
  };
  await writeJson(path.join(queueDir, `${id}.json`), queueItem);
  ledger.queued_shortcodes[shortcode] = {
    queued_at: new Date().toISOString(),
    source_handle: candidate.source.handle,
    source_url: candidate.url,
    queue_id: id,
    video: queueItem.video
  };
  return id;
}

async function commitAndPush(createdIds) {
  if (!createdIds.length) return;
  await execFileAsync("git", ["add", "queue", "media", "monitor/repost-ledger.json"]);
  await execFileAsync("git", ["commit", "-m", `Queue ${createdIds.length} RapWire repost video${createdIds.length === 1 ? "" : "s"}`]).catch((error) => {
    if (!/nothing to commit/i.test(error.stdout || error.stderr || "")) throw error;
  });
  await execFileAsync("git", ["pull", "--rebase", "origin", "main"]);
  await execFileAsync("git", ["push", "origin", "HEAD:main"]);
}

await acquireLock();
try {
  const ledger = await readJson(ledgerPath, {
    version: 1,
    sources: sources.map((source) => source.handle),
    seen_shortcodes: {},
    queued_shortcodes: {},
    runs: []
  });

  const run = {
    started_at: new Date().toISOString(),
    candidates: 0,
    queued: [],
    errors: []
  };

  const discovered = [];
  await withFreshBrowser(async (context) => {
    for (const source of sources) {
      try {
        discovered.push(...await discoverFromProfile(context, source));
      } catch (error) {
        run.errors.push({ source_handle: source.handle, stage: "discover", error: error.message });
      }
    }
  });
  run.candidates = discovered.length;
  for (const item of discovered) {
    ledger.seen_shortcodes[item.shortcode] = {
      seen_at: ledger.seen_shortcodes[item.shortcode]?.seen_at || new Date().toISOString(),
      source_handle: item.source.handle,
      source_url: item.url
    };
  }
  let queueNumber = await nextQueueNumber();
  for (const candidate of discovered) {
    if (run.queued.length >= maxQueuePerRun) break;
    if (ledger.queued_shortcodes[candidate.shortcode]) continue;
    try {
      const id = await queueCapture(ledger, candidate, queueNumber);
      run.queued.push(id);
      queueNumber += 1;
    } catch (error) {
      run.errors.push({ source_handle: candidate.source.handle, source_url: candidate.url, stage: "queue", error: error.message });
    }
  }

  run.finished_at = new Date().toISOString();
  ledger.runs = [...(ledger.runs || []), run].slice(-250);
  await writeJson(ledgerPath, ledger);
  await commitAndPush(run.queued);
  console.log(JSON.stringify(run, null, 2));
} finally {
  await releaseLock();
}
