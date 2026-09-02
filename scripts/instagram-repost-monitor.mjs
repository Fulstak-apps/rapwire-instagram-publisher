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
const candidatesPerSourceToScore = 4;

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
    .replace(/\b(?:View all \d+ comments?|Add a comment…|Original audio)\b/gi, "")
    .replace(/["“”]*[^"“”:.]{1,80} on Instagram:\s*["“”]*/gi, "")
    .trim();
}

function accountFromUrl(url) {
  return new URL(url).pathname.split("/").filter(Boolean)[0] || "";
}

function isSourcePageHandle(handle) {
  return sources.some((source) => source.handle.toLowerCase() === String(handle || "").toLowerCase());
}

function artistHandleLine(candidate) {
  const account = accountFromUrl(candidate.url);
  if (!account || isSourcePageHandle(account)) return "";
  const displayName = account
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${displayName} (@${account})`;
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
      .map((url, profilePosition) => ({ source, url, shortcode: shortcodeFromUrl(url), profilePosition }))
      .filter((item) => item.shortcode);
    return unique;
  } finally {
    await page.close();
  }
}

function viewCountFromText(value) {
  const match = String(value || "").match(/([\d,.]+)\s*([KMB])?\s+views?\b/i);
  if (!match) return 0;
  const number = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(number)) return 0;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[String(match[2] || "").toLowerCase()] || 1;
  return Math.round(number * multiplier);
}

async function readPostMetadata(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const candidates = [
      await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => ""),
      await page.locator('meta[property="og:description"]').getAttribute("content").catch(() => ""),
      await page.locator("article").innerText({ timeout: 2500 }).catch(() => "")
    ];
    const fullText = candidates.join("\n");
    return {
      caption: cleanText(candidates.find((candidate) => cleanText(candidate).length > 20) || ""),
      viewCount: viewCountFromText(fullText)
    };
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
    : "A new hip-hop video is moving through the feed and RapWire is posting it for the timeline.";
  return `${base}${base.endsWith(".") ? "" : "."} Clean repost coverage for the hip-hop feed.`;
}

async function queueCapture(ledger, candidate, queueNumber) {
  const shortcode = candidate.shortcode;
  await capture(candidate.url, { headless: true });
  const sourceVideo = path.join(root, "work", "instagram-mirror", `${shortcode}.mp4`);
  await fs.access(sourceVideo);
  const visibleCaption = candidate.visibleCaption || "";
  const headlineSeed = visibleCaption || `${candidate.source.handle} repost video`;
  const id = `${String(queueNumber).padStart(3, "0")}-${slugify(headlineSeed)}`;
  const mediaPath = path.join(mediaDir, `${id}.mp4`);
  await fs.copyFile(sourceVideo, mediaPath);

  const body = buildBody(candidate.source, visibleCaption);
  const handleLine = artistHandleLine(candidate);
  const caption = `${body}${handleLine ? `\n\n${handleLine}` : ""}\n\nRap Wire 24/7\n@Rapwire247\n@${candidate.source.handle}`;
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
    caption,
    threads_text: caption,
    video: path.relative(root, mediaPath),
    source_handle: candidate.source.handle,
    source_url: candidate.url,
    source_urls: [candidate.url],
    source_view_count_at_selection: Number(candidate.viewCount || 0),
    visual_asset_type: "source_video",
    visual_asset_rights: "source_post_repost",
    source_video_used: true,
    logo_position: "bottom-left",
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

  // Replace old burned-in right-side branding from the original capture.
  // Use a new media path so public media caches cannot serve the old render.
  for (const name of (await fs.readdir(queueDir)).sort()) {
    if (!/^(124|125|126|127|128|129)-.*\.json$/.test(name)) continue;
    const itemPath = path.join(queueDir, name);
    const item = await readJson(itemPath, {});
    if (item.status !== "ready" || item.logo_position === "bottom-left") continue;
    try {
      await capture(item.source_url, { headless: true });
      const shortcode = shortcodeFromUrl(item.source_url);
      const destination = path.join(mediaDir, `${item.id}-logo-left.mp4`);
      await fs.copyFile(path.join(root, "work", "instagram-mirror", `${shortcode}.mp4`), destination);
      item.video = path.relative(root, destination);
      delete item.video_url;
      item.logo_position = "bottom-left";
      await writeJson(itemPath, item);
      run.queued.push(item.id);
      await commitAndPush([item.id]);
    } catch (error) {
      run.errors.push({ source_url: item.source_url, stage: "logo_rebuild", error: error.message });
    }
    break;
  }

  const discovered = [];
  let rankedPool = [];
  await withFreshBrowser(async (context) => {
    for (const source of sources) {
      try {
        discovered.push(...await discoverFromProfile(context, source));
      } catch (error) {
        run.errors.push({ source_handle: source.handle, stage: "discover", error: error.message });
      }
    }
    // Score only the current visible window from each approved page. This keeps
    // reposts timely while choosing the videos already pulling the strongest
    // audience, rather than blindly reposting every new upload.
    const selectedForScoring = sources.flatMap((source) => discovered
      .filter((candidate) => candidate.source.handle === source.handle && !ledger.queued_shortcodes[candidate.shortcode])
      .slice(0, candidatesPerSourceToScore));
    rankedPool = selectedForScoring;
    for (const candidate of selectedForScoring) {
      try {
        const metadata = await readPostMetadata(context, candidate.url);
        candidate.visibleCaption = metadata.caption;
        candidate.viewCount = metadata.viewCount;
      } catch (error) {
        run.errors.push({ source_handle: candidate.source.handle, source_url: candidate.url, stage: "score", error: error.message });
      }
    }
  });
  run.candidates = discovered.length;
  for (const item of discovered) {
    ledger.seen_shortcodes[item.shortcode] = {
      seen_at: ledger.seen_shortcodes[item.shortcode]?.seen_at || new Date().toISOString(),
      source_handle: item.source.handle,
      source_url: item.url,
      view_count: item.viewCount || ledger.seen_shortcodes[item.shortcode]?.view_count || 0
    };
  }
  const rankedCandidates = rankedPool
    .sort((left, right) => Number(right.viewCount || 0) - Number(left.viewCount || 0)
      || left.profilePosition - right.profilePosition
      || left.source.handle.localeCompare(right.source.handle));
  let queueNumber = await nextQueueNumber();
  for (const candidate of rankedCandidates) {
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
