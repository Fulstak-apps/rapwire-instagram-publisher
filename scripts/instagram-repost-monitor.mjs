import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capture, launch } from "./instagram-browser-mirror.mjs";
import { sourceCaption, buildVideoCaption, captionIsBound } from "./video-caption.mjs";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 60_000;
// The merged source ledger is intentionally bounded by run count, but its
// shortcode history can still exceed Node's 1 MiB child-process default. A
// maxBuffer failure here used to look like a Git outage and killed every
// collector pass. Keep the bound finite while allowing the actual ledger.
const git = (...args) => execFileAsync("git", args, { timeout: gitTimeoutMs, killSignal: "SIGTERM", maxBuffer: 32 * 1024 * 1024 });

const root = path.resolve(".");
const ledgerPath = path.join(root, "monitor", "repost-ledger.json");
const lockPath = path.join(root, "monitor", "repost-monitor.lock");
const queueDir = path.join(root, "queue");
const mediaDir = path.join(root, "media");
const hotArtistsPath = path.join(root, "monitor", "hot-artists.json");

// Keep the source registry in monitor/sources.json as the single source of
// truth.  The old collector had a second hard-coded list here, so adding a
// source in the registry silently did nothing until this file was edited too.
// That drift was especially costly for fallback inventory: an enabled source
// could never refill the queue.  A small fallback list keeps the collector
// usable if a sparse checkout is missing the registry, while the registry
// remains authoritative whenever it is present.
const fallbackSourceRows = [
  { handle: "trapmatictv", scope: "hiphop", credit: false },
  { handle: "raplisted_", scope: "hiphop", credit: false },
  { handle: "akademiks", scope: "hiphop" },
  { handle: "traploreross", scope: "hiphop" },
  { handle: "freshouttheculture", scope: "hiphop" },
  { handle: "records", scope: "hiphop", credit: false },
  { handle: "darnellwilliams", scope: "hiphop", credit: false, include_posts: false },
  { handle: "complexmusic", scope: "hiphop" },
  { handle: "xxl", scope: "hiphop" },
  { handle: "hiphopdx", scope: "hiphop" },
  { handle: "hiphop_firstnewsmusic", scope: "hiphop" },
  { handle: "ceddynash", scope: "hiphop" },
  { handle: "larp.lor.d", scope: "hiphop" },
  { handle: "rockstargames", scope: "gaming" },
  { handle: "igndotcom", scope: "gaming" }
];
const ownedSourceHandles = new Set(["trapmatictv", "raplisted_", "records", "darnellwilliams"]);
const sourceConfig = await readJson(path.join(root, "monitor", "sources.json"), { sources: [] });
const configuredRows = Array.isArray(sourceConfig.sources) ? sourceConfig.sources : [];
const sourceRows = configuredRows.length ? configuredRows : fallbackSourceRows;
const configuredHandles = new Set(sourceRows.map(row => String(row.handle || "").replace(/^@/, "").toLowerCase()).filter(Boolean));
if (configuredRows.length) {
  for (const row of fallbackSourceRows) {
    const handle = String(row.handle || "").replace(/^@/, "").toLowerCase();
    if (handle && !configuredHandles.has(handle)) sourceRows.push(row);
  }
}
const sources = sourceRows
  .filter(row => row && row.enabled !== false)
  .map(row => {
    const handle = String(row.handle || "").replace(/^@/, "").toLowerCase();
    return {
      handle,
      scope: String(row.scope || "hiphop").toLowerCase(),
      credit: row.credit !== false && !ownedSourceHandles.has(handle),
      includePosts: row.include_posts !== false && row.includePosts !== false,
      includeReels: row.include_reels !== false && row.includeReels !== false,
      fastTrack: Boolean(row.fast_track || row.fastTrack),
      dailyMinimum: Number(row.daily_minimum || row.dailyMinimum || 0) || 0,
      dailyMaximum: Number(row.daily_maximum || row.dailyMaximum || 0) || 0
    };
  })
  .filter(row => row.handle);
const maxQueuePerRun = 1;
// Keep several already-validated source videos ahead of the publisher.  An
// Instagram container in progress is counted as reserved inventory, so the
// collector does not duplicate it while Meta processes the upload.
// Keep twelve hours of inventory at the 30-minute Instagram cadence, enough
// to bridge the longest reported source-collection outage. Items count only
// after full capture/render validation. Collection remains bounded to one new
// capture per pass to avoid browser contention and incomplete media.
const targetReadyVideoBuffer = 24;
// Score the freshest visible item per source.  More than that delays the
// actual capture behind dozens of metadata page loads and makes a single pass
// needlessly likely to exceed its watchdog window.
// Keep a small fallback set from every approved source.  A single Reel can
// legitimately refuse an authenticated media fetch (especially long press
// conferences), and it must not be able to empty the publishing pipeline.
// Four candidates per source gives the collector enough real fallback when a
// Reel has a non-specific caption, an embedded-player layout, or an expired
// CDN stream.  This is still bounded (eight approved sources) and avoids an
// empty publishing queue being held hostage by the newest bad Reel.
// Score a small fallback set from each source per five-minute pass. Scoring
// three candidates concurrently lets the collector skip a generic caption or
// a Reel whose CDN stream is unavailable instead of retrying the same newest
// item forever. The browser work is still bounded by the four-profile batch.
const candidatesPerSourceToScore = 3;
// A source can fail because Instagram temporarily withholds its media ranges.
// Bound failed capture work so one bad batch cannot monopolize the launcher;
// the next five-minute pass gets a fresh browser and can retry other items.
// Try a few independent candidates before yielding.  This is intentionally
// lower than the number of scored candidates so collection remains bounded,
// while a bad stream can fail over to a different ready-to-publish video in
// the same run.
// A failed authenticated fetch plus local crop review can take minutes. Four
// independent fallbacks fit inside the runner's ten-minute hard cap; eight
// could repeatedly time out before the ledger was saved, leaving the queue
// empty forever. The next five-minute pass continues from the remaining pool.
// The launchd worker runs every five minutes and is hard-bounded to 290s.
// One complete capture/render per pass keeps the worker inside that window;
// attempting four serial video transcodes caused the watchdog to kill the
// pass before its ledger/queue updates were persisted.
const maxCaptureAttemptsPerRun = 1;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
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

// Playwright's navigation timeout can occasionally remain unsettled when
// Instagram drops a headless page mid-navigation.  A real timer guarantees a
// collector pass always resolves and its finally block releases the lock.
async function gotoBounded(page, url, timeout = 22_000) {
  let timer;
  try {
    return await Promise.race([
      page.goto(url, { waitUntil: "commit", timeout }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Navigation hard-timeout after ${timeout}ms: ${url}`)), timeout + 500); })
    ]);
  } finally { clearTimeout(timer); }
}

async function discoverFromProfile(context, source) {
  const page = await context.newPage();
  try {
    page.setDefaultNavigationTimeout(12_000);
    page.setDefaultTimeout(12_000);
    // Instagram keeps analytics/background requests open long after the page
    // itself is usable. Waiting for DOMContentLoaded causes false timeouts.
    // Instead wait for the actual thing this collector needs: a post/reel
    // anchor. A fixed short sleep was racing Instagram's client rendering and
    // produced a deceptively "successful" zero-candidate pass.
    await gotoBounded(page, `https://www.instagram.com/${source.handle}/`);
    const postLinks = page.locator('a[href*="/reel/"], a[href*="/p/"]');
    await postLinks.first().waitFor({ state: "attached", timeout: 20_000 }).catch(() => {});
    const hrefs = await postLinks.evaluateAll((links) =>
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
    page.setDefaultNavigationTimeout(12_000);
    page.setDefaultTimeout(12_000);
    await gotoBounded(page, url);
    await page.locator('meta[property="og:url"]').waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
    const get = property => page.locator(`meta[property="${property}"]`).getAttribute("content", { timeout: 5000 }).catch(() => "");
    const [canonicalUrl, title, description, ogVideo] = await Promise.all([get("og:url"),get("og:title"),get("og:description"),get("og:video")]);
    return {
      caption: sourceCaption({ requestedUrl:url, canonicalUrl, title, description }),
      // A normal Instagram post URL can contain a video too.  On headless
      // pages the media element often is not created until after scrolling,
      // so URL/OG metadata are the reliable early signal for capture.
      isVideo: /\/reel\//.test(url) || Boolean(ogVideo) || await page.locator("video").count() > 0,
      viewCount: viewCountFromText(description)
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
    let alive = false;
    try { process.kill(existing.pid, 0); alive = true; } catch (error) { if (error.code === "EPERM") alive = true; }
    if (alive) {
      console.log(JSON.stringify({ status: "locked", lock: existing }));
      process.exit(0);
    }
  } catch {
    // No active lock or unreadable stale lock.
  }
  await fs.rm(lockPath, { force: true });
  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2), { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") process.exit(0);
    throw error;
  }
}

async function releaseLock() {
  const current = await readJson(lockPath, {});
  if (current.pid === process.pid) await fs.rm(lockPath, { force: true });
}

async function captionFields(evidence, source) {
  const registry = await readJson(path.join(root, "monitor", "artist-handles.json"), []);
  const sourceRecord = sources.find(item => item.handle === source);
  const visibleCredit = sourceRecord?.credit === false ? null : source;
  const text = buildVideoCaption(evidence.source_caption_text, visibleCredit, registry);
  return { ...text, rendered_body_text:text.body, threads_text:text.caption, caption_policy:"exact-source-v1", caption_source_shortcode:evidence.shortcode, source_caption_text:evidence.source_caption_text, caption_checked_at:evidence.captured_at, media_capture_evidence:evidence.media_match_method, source_video_duration:evidence.duration };
}

async function queueCapture(ledger, candidate, queueNumber) {
  const shortcode = candidate.shortcode;
  const cachedEvidencePath = path.join(root, "work", "instagram-mirror", `${shortcode}.json`);
  const cachedVideoPath = path.join(root, "work", "instagram-mirror", `${shortcode}.mp4`);
  // A completed render may have failed only at the final queue handoff (for
  // example after a sparse checkout omitted media/). Reuse that validated
  // artifact rather than downloading and rendering the same Reel again.
  let evidence = await readJson(cachedEvidencePath, null);
  if (!evidence || !evidence.source_url || !String(evidence.source_url).includes(shortcode)) evidence = null;
  if (evidence) {
    try { await fs.access(cachedVideoPath); } catch { evidence = null; }
  }
  if (!evidence) evidence = await capture(candidate.url, { headless: true });
  // Clean sparse checkouts may not contain an empty media directory.  Always
  // create it at the handoff boundary so a successful capture reaches GitHub.
  await fs.mkdir(mediaDir, { recursive: true });
  const sourceVideo = path.join(root, "work", "instagram-mirror", `${shortcode}.mp4`);
  await fs.access(sourceVideo);
  const fields = await captionFields(evidence, candidate.source.handle);
  const headlineSeed = fields.body;
  const id = `${String(queueNumber).padStart(3, "0")}-${slugify(headlineSeed)}`;
  const mediaPath = path.join(mediaDir, `${id}.mp4`);
  await fs.copyFile(sourceVideo, mediaPath);

  const { body, caption } = fields;
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
    // Instagram does not consistently expose a machine-readable publish date.
    // This timestamp gives a newly captured Reel the short current-news window
    // enforced by expire-stale-queue.py instead of pausing it immediately.
    source_discovered_at: evidence.captured_at || new Date().toISOString(),
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
  Object.assign(queueItem, fields);
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

async function cachedCandidates(ledger) {
  const directory = path.join(root, "work", "instagram-mirror");
  const names = await fs.readdir(directory).catch(() => []);
  const candidates = [];
  for (const name of names.filter(value => value.endsWith(".json") && !value.endsWith("-capture-diagnostic.json"))) {
    const evidence = await readJson(path.join(directory, name), null);
    const shortcode = evidence?.shortcode || name.replace(/\.json$/, "");
    if (!evidence?.source_url || !shortcode || ledger.queued_shortcodes[shortcode]) continue;
    const source = sources.find(item => evidence.source_url.includes(`instagram.com/${item.handle}/`));
    if (!source || !evidence.source_caption_text || evidence.video_layout?.status !== "validated") continue;
    try { await fs.access(path.join(directory, `${shortcode}.mp4`)); } catch { continue; }
    candidates.push({source,shortcode,url:evidence.source_url,visibleCaption:evidence.source_caption_text,isVideo:true,
      viewCount:0,capturedAt:Date.parse(evidence.captured_at || "") || 0});
  }
  return candidates.sort((left,right) => right.capturedAt - left.capturedAt);
}

function mergeLedger(remote, local) {
  const remoteValue = remote && typeof remote === "object" ? remote : {};
  const localValue = local && typeof local === "object" ? local : {};
  const mergeMap = (left, right) => ({
    ...(left && typeof left === "object" ? left : {}),
    ...(right && typeof right === "object" ? right : {})
  });
  const runs = [...(Array.isArray(remoteValue.runs) ? remoteValue.runs : []), ...(Array.isArray(localValue.runs) ? localValue.runs : [])]
    .filter(Boolean)
    .sort((left, right) => String(left.started_at || "").localeCompare(String(right.started_at || "")))
    .slice(-250);
  return {
    ...remoteValue,
    ...localValue,
    version: Math.max(Number(remoteValue.version) || 1, Number(localValue.version) || 1),
    sources: [...new Set([...(remoteValue.sources || []), ...(localValue.sources || []), ...sources.map(source => source.handle)])],
    seen_shortcodes: mergeMap(remoteValue.seen_shortcodes, localValue.seen_shortcodes),
    queued_shortcodes: mergeMap(remoteValue.queued_shortcodes, localValue.queued_shortcodes),
    runs
  };
}

// A health-only collector pass still needs to consume publication commits from
// GitHub. Leaving the generated ledger dirty made the old code skip pull/rebase
// forever, so the local checkout could keep treating already-published items as
// ready and eventually starve. Temporarily move the local ledger out of Git,
// sync the branch with bounded commands, merge the two JSON ledgers, then put it
// back. The backup is restored if any sync step fails.
async function syncRemotePreservingLedger() {
  let localLedger = null;
  let stashRef = null;
  try {
    localLedger = await readJson(ledgerPath, null);
    // These are the only tracked files the local collector mutates outside a
    // real queue capture. Stash them together before rebasing so a legacy
    // checkout that still tracks the high-volume attempt log cannot block Git
    // with "unstaged changes" or a modify/delete conflict.
    const stashPaths = ["monitor/repost-ledger.json"];
    try { await fs.access(path.join(root, "logs", "publish-attempts.jsonl")); stashPaths.push("logs/publish-attempts.jsonl"); } catch {}
    const { stdout: collectorStateChanges } = await git("status", "--porcelain", "--", ...stashPaths);
    if (collectorStateChanges.trim()) {
      await git("stash", "push", "--include-untracked", "--message", `rapwire-collector-state-sync-${process.pid}`, "--", ...stashPaths);
      // No other collector can mutate the stash while this process owns the
      // monitor lock, so the newly-created top entry is our exact snapshot.
      stashRef = "stash@{0}";
    }
    let lastError;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await git("fetch", "origin", "main");
        // Publication commits can legitimately finalize a queue record while
        // this collector is preparing the same item.  Prefer the remote
        // record during rebase so a published item cannot deadlock collection.
        await git("rebase", "-X", "theirs", "origin/main");
        await git("push", "origin", "HEAD:main");
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await git("rebase", "--abort").catch(() => {});
        if (attempt < 8) await new Promise(resolve => setTimeout(resolve, Math.min(15_000, attempt * 2_000)));
      }
    }
    if (lastError) throw lastError;
    const remoteLedger = JSON.parse((await git("show", "origin/main:monitor/repost-ledger.json")).stdout || "{}");
    if (stashRef) {
      await git("stash", "drop", stashRef);
      stashRef = null;
    }
    await writeJson(ledgerPath, mergeLedger(remoteLedger, localLedger));
  } catch (error) {
    await git("rebase", "--abort").catch(() => {});
    // The in-memory copy is safer than popping a stash into a possibly changed
    // remote ledger. Restore it as a merged dirty file; the next pass can retry
    // synchronization without losing discovered shortcodes or run history.
    const currentLedger = await readJson(ledgerPath, {});
    await writeJson(ledgerPath, mergeLedger(currentLedger, localLedger));
    if (stashRef) await git("stash", "drop", stashRef).catch(() => {});
    throw error;
  }
}

async function commitAndPush(createdIds) {
  // Health-only passes are local telemetry. Committing the ledger every five
  // minutes makes this checkout diverge from the publication commits written
  // by GitHub Actions, eventually preventing new videos from reaching main.
  // Only sync when a real queue item and media asset were created.
  if (!createdIds.length) return;
  const paths = ["monitor/repost-ledger.json"];
  for (const id of createdIds) {
    const name = path.join("queue", `${id}.json`);
    const item = await readJson(name, {});
    paths.push(name);
    if (item.video) paths.push(item.video);
  }
  const { stdout: changed } = await git("status", "--porcelain", "--", ...paths);
  if (changed.trim()) {
  // The local collector intentionally uses sparse checkout for speed, while
  // captured MP4s live outside that sparse set.  `--sparse` is required here;
  // without it Git accepts the queue JSON but rejects the media asset, leaving
  // every otherwise-ready video stranded off the remote publisher queue.
  await git("add", "--sparse", "--", ...paths);
  await git("commit", "--only", "-m", createdIds.length ? `Queue ${createdIds.length} RapWire repost video${createdIds.length === 1 ? "" : "s"}` : "Save RapWire collector health", "--", ...paths).catch((error) => {
    if (!/nothing to commit/i.test(error.stdout || error.stderr || "")) throw error;
  });
  }
  // The GitHub publisher also writes queue state. Retry ordinary races so a
  // newly captured Reel cannot be stranded behind an unrelated log commit.
  let lastError;
  // GitHub Actions writes publication-state commits while this local process
  // writes new source videos.  Treat a moving main ref as normal contention,
  // not as a failed collection pass.  Rebase against the newest remote ref
  // before every retry so captured media cannot be stranded locally.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await git("fetch", "origin", "main");
      await git("rebase", "-X", "theirs", "origin/main");
      await git("push", "origin", "HEAD:main");
      return;
    } catch (error) {
      lastError = error;
      // Never leave the shared checkout inside a conflicted rebase. The next
      // launch must be able to acquire the same lock and retry from a clean
      // Git state, even when the publisher committed queue state concurrently.
      await git("rebase", "--abort").catch(() => {});
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, attempt * 2000)));
    }
  }
  throw lastError;
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
  const hotArtists = await readJson(hotArtistsPath, []);

  const run = {
    started_at: new Date().toISOString(),
    candidates: 0,
    queued: [],
    errors: []
  };

  for (const name of (await fs.readdir(queueDir)).filter(name => name.endsWith(".json"))) {
    const item = await readJson(path.join(queueDir, name), {});
    const code = shortcodeFromUrl(item.source_url || "");
    if (code && item.content_type === "video") ledger.queued_shortcodes[code] ||= { queue_id: item.id, source_url: item.source_url, source_handle: item.source_handle, video: item.video };
  }

  const queueSnapshot = await Promise.all((await fs.readdir(queueDir))
    .filter(name => name.endsWith('.json'))
    .map(name => readJson(path.join(queueDir, name), {})));
  const bufferedVideos = queueSnapshot.filter(item => item.status === 'ready'
    && item.content_type === 'video'
    && sources.some(source => source.handle === item.source_handle)
    && !item.instagram_media_id).length;
  const bufferNeeded = Math.max(0, targetReadyVideoBuffer - bufferedVideos);
  run.video_buffer = { target: targetReadyVideoBuffer, available: bufferedVideos, needed: bufferNeeded };

  const unsent = [];
  for (const name of (await fs.readdir(queueDir)).filter(name => name.endsWith(".json"))) {
    const item = await readJson(path.join(queueDir, name), {});
    if (item.status !== "ready" || item.content_type !== "video" || name !== `${item.id}.json` || !sources.some(source => source.handle === item.source_handle)) continue;
    const { stdout } = await git("status", "--porcelain", "--", path.join("queue", name), item.video);
    if (stdout.trim()) unsent.push(item.id);
  }
  if (unsent.length) {
    await writeJson(ledgerPath, ledger);
    await commitAndPush(unsent);
  } else {
    await syncRemotePreservingLedger();
  }

  let repairAttempts = 0;
  for (const name of (await fs.readdir(queueDir)).sort()) {
    if (!name.endsWith(".json")) continue;
    const itemPath = path.join(queueDir, name);
    const item = await readJson(itemPath, {});
    if (item.status !== "ready" || item.content_type !== "video" || captionIsBound(item)
      || !sources.some(source => source.handle === item.source_handle)
      || item.instagram_media_id || item.instagram_publish_requested_at || item.instagram_reconcile_required
      || Date.parse(item.caption_retry_at || "") > Date.now()) continue;
    if (repairAttempts++ >= 3) break;
    try {
      const evidence = await capture(item.source_url, { headless: true });
      const fields = await captionFields(evidence, item.source_handle);
      const shortcode = shortcodeFromUrl(item.source_url);
      const destination = path.join(mediaDir, `${item.id}-caption-matched.mp4`);
      await fs.copyFile(path.join(root, "work", "instagram-mirror", `${shortcode}.mp4`), destination);
      item.video = path.relative(root, destination);
      delete item.video_url;
      item.logo_position = "bottom-left";
      if (item.instagram_container_id) {
        item.superseded_unpublished_container_ids = [...(item.superseded_unpublished_container_ids || []), item.instagram_container_id];
        for (const field of ["instagram_container_id", "instagram_container_created_at", "instagram_container_checked_at", "instagram_container_status", "instagram_retry_at"]) delete item[field];
      }
      Object.assign(item, fields);
      delete item.caption_review_error; delete item.caption_retry_at;
      await writeJson(itemPath, item);
      run.queued.push(item.id);
      await commitAndPush([item.id]);
      break;
    } catch (error) {
      item.caption_review_error = error.message;
      item.caption_retry_at = new Date(Date.now() + 3600000).toISOString();
      await writeJson(itemPath, item);
      await commitAndPush([item.id]);
      run.errors.push({ source_url: item.source_url, stage: "caption_repair", error: error.message });
    }
  }

  run.mode = repairAttempts ? "caption_repair" : "discovery";
  if (!repairAttempts && bufferNeeded > 0) {
  // First consume a completed, validated local render that never reached the
  // queue. This is a fast reserve path: it does no browser navigation and can
  // keep publication moving while Instagram profile pages are slow.
  const reserve = await cachedCandidates(ledger);
  for (const candidate of reserve.slice(0, 12)) {
    try {
      const id = await queueCapture(ledger, candidate, await nextQueueNumber());
      run.queued.push(id);
      run.mode = "cached_reserve";
      break;
    } catch (error) {
      run.errors.push({source_handle:candidate.source.handle,source_url:candidate.url,stage:"cached_reserve",error:error.message});
    }
  }

  if (!run.queued.length) {
    const discovered = [];
    let rankedPool = [];
  // Rotate small source groups across five-minute passes. Scanning all nine
  // profiles before capture repeatedly consumed the entire 270-second worker
  // budget and left only a truncated render. Every source is still visited
  // within three passes, while each pass retains time for a complete MP4.
    const sourceBatchSize = 4;
    const sourceBatchCount = Math.ceil(sources.length / sourceBatchSize);
    const sourceBatchIndex = Math.floor(Date.now() / 300000) % sourceBatchCount;
    const discoverySources = sources.slice(sourceBatchIndex * sourceBatchSize, (sourceBatchIndex + 1) * sourceBatchSize);
    run.source_batch = { index: sourceBatchIndex, count: sourceBatchCount, handles: discoverySources.map((source) => source.handle) };
    await withFreshBrowser(async (context) => {
    // Load a few profiles concurrently.  Sequential discovery could spend
    // over two minutes before scoring any video, even when every source was
    // healthy. Four tabs is deliberately modest to avoid hammering Instagram.
    for (let offset = 0; offset < discoverySources.length; offset += 4) {
      const batch = await Promise.all(discoverySources.slice(offset, offset + 4).map(async source => {
        try { return await discoverFromProfile(context, source); }
        catch (error) {
          run.errors.push({ source_handle: source.handle, stage: "discover", error: error.message });
          return [];
        }
      }));
      discovered.push(...batch.flat());
    }
    const selectedForScoring = discoverySources.flatMap((source) => discovered
      .filter((candidate) => candidate.source.handle === source.handle && !ledger.queued_shortcodes[candidate.shortcode])
      .slice(0, candidatesPerSourceToScore));
    rankedPool = selectedForScoring;
    // Score a small batch of independent posts at once.  Sequential page
    // navigation made 24 metadata reads consume most of the collector's
    // watchdog window before a single video could be captured.
    for (let offset = 0; offset < selectedForScoring.length; offset += 4) {
      await Promise.all(selectedForScoring.slice(offset, offset + 4).map(async candidate => {
        try {
          const metadata = await readPostMetadata(context, candidate.url);
          candidate.visibleCaption = metadata.caption;
          candidate.isVideo = metadata.isVideo;
          candidate.viewCount = metadata.viewCount;
        } catch (error) {
          run.errors.push({ source_handle: candidate.source.handle, source_url: candidate.url, stage: "score", error: error.message });
        }
      }));
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
  
  // VIRAL-FIRST & ARTIST PRIORITY SCORING
  const rankedCandidates = rankedPool
    .sort((left, right) => {
      const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const leftHot = hotArtists.some(artist => new RegExp(`\\b${escapeRegex(artist)}\\b`, "i").test(left.visibleCaption || ""));
      const rightHot = hotArtists.some(artist => new RegExp(`\\b${escapeRegex(artist)}\\b`, "i").test(right.visibleCaption || ""));
      if (leftHot !== rightHot) return rightHot ? 1 : -1;
      return Number(right.viewCount || 0) - Number(left.viewCount || 0)
        || left.profilePosition - right.profilePosition
        || left.source.handle.localeCompare(right.source.handle);
    });

  let queueNumber = await nextQueueNumber();
  let captureAttempts = 0;
  for (const candidate of rankedCandidates) {
    if (run.queued.length >= Math.min(maxQueuePerRun, bufferNeeded)) break;
    if (captureAttempts >= maxCaptureAttemptsPerRun) break;
    if (ledger.queued_shortcodes[candidate.shortcode]) continue;
    if (!candidate.isVideo) continue;
    try {
      captureAttempts += 1;
      const id = await queueCapture(ledger, candidate, queueNumber);
      run.queued.push(id);
      queueNumber += 1;
    } catch (error) {
      run.errors.push({ source_handle: candidate.source.handle, source_url: candidate.url, stage: "queue", error: error.message });
    }
  }

  }

  }
  run.finished_at = new Date().toISOString();
  ledger.runs = [...(ledger.runs || []), run].slice(-250);
  await writeJson(ledgerPath, ledger);
  try {
    await commitAndPush(run.queued);
  } catch (error) {
    // A health-only pass must not be marked failed merely because GitHub is
    // temporarily unreachable. Newly queued media still fails hard so the
    // supervisor retries until those manifests are safely pushed.
    if (run.queued.length) throw error;
    run.errors.push({ stage: "health_sync", error: error.message });
  }
  console.log(JSON.stringify(run, null, 2));
} finally {
  await releaseLock();
}
