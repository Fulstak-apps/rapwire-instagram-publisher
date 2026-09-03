import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { readExactPost } from "./post-metadata.mjs";
import { capturePostMedia } from "./post-media.mjs";
import { assembleRanges } from "./media-ranges.mjs";
import { renderFootageOnly } from "./video-footage.mjs";

const execFileAsync = promisify(execFile);

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = path.join(os.homedir(), "Library", "Application Support", "RapWire", "InstagramMirrorProfile");
const outputDir = path.resolve("work", "instagram-mirror");

async function launch(headless = false) {
  await fs.mkdir(profileDir, { recursive: true });
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        executablePath: chromePath,
        headless,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true
      });
    } catch (error) {
      lastError = error;
      if (!/ProcessSingleton|SingletonLock|profile directory/i.test(error.message || "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2500 + attempt * 1000));
    }
  }
  throw lastError;
}

async function assertRapWireLogin(page) {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const profileLink = page.locator('a[href="/rapwire247/"]');
  if (!(await profileLink.count())) {
    throw new Error("Dedicated mirror profile is not signed into @rapwire247. Run npm run mirror:login first.");
  }
}

async function login() {
  const context = await launch(false);
  const page = context.pages()[0] || await context.newPage();
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  console.log("Sign into @rapwire247 in this dedicated window, then close the window. The login will be reused by scheduled runs.");
  // Login is intentionally interactive and may take longer than Playwright's
  // default 30-second event timeout.
  await new Promise((resolve) => context.once("close", resolve));
}

async function captureVideo(page, video, candidates, reelUrl, options, destination, shortcode) {
    await video.waitFor({ state: "visible", timeout: 15_000 });
    // Clicking blindly may pause autoplay, leaving only the first media range.
    await video.evaluate(element => { element.muted = false; return element.play().catch(() => { element.muted = true; return element.play(); }); });
    await page.waitForTimeout(3000);
    const sourceEvidence = await readExactPost(page, reelUrl, options.vip ? {...options, video} : options);
    const bufferDeadline = Date.now() + Math.min(240000, (sourceEvidence.duration + 15) * 1000);
    let fullyBuffered = false;
    while (Date.now() < bufferDeadline) {
      const buffered = await video.evaluate(element => ({ end: element.buffered.length ? element.buffered.end(element.buffered.length - 1) : 0, duration:element.duration }));
      if (buffered.end >= buffered.duration - 0.25) { fullyBuffered = true; break; }
      await page.waitForTimeout(2500);
    }
    // Let response.body() handlers finish after the last buffered segment.
    await page.waitForTimeout(1500);
    if (!candidates.length) throw new Error("No authenticated video response was captured from Instagram.");
    const groups = new Map();
    for (const item of candidates) {
      const parsed = new URL(item.url);
      const rangeStart = Number(item.headers["content-range"]?.match(/bytes (\d+)-/)?.[1] ?? parsed.searchParams.get("bytestart") ?? 0);
      const rangeEndValue = item.headers["content-range"]?.match(/bytes \d+-(\d+)/)?.[1] ?? parsed.searchParams.get("byteend");
      const rangeEnd = rangeEndValue == null ? undefined : Number(rangeEndValue);
      parsed.searchParams.delete("bytestart");
      parsed.searchParams.delete("byteend");
      const key = parsed.toString();
      const group = groups.get(key) || [];
      group.push({ ...item, rangeStart, rangeEnd });
      groups.set(key, group);
    }
    const assembled = [...groups.values()]
      .map((parts) => ({ parts: parts.sort((a, b) => a.rangeStart - b.rangeStart), bytes: parts.reduce((sum, part) => sum + part.body.length, 0) }))
      .sort((a, b) => b.bytes - a.bytes);
    const tempDir = await fs.mkdtemp(path.join(outputDir, `${shortcode}-`));
    let videoInput = "";
    let audioInput = "";
    try {
      const matchedVideos = [];
      const matchedAudio = [];
      const diagnostics = [];
      for (let index = 0; index < assembled.length; index += 1) {
        const bytes = assembleRanges(assembled[index].parts, { allowBufferedRanges:fullyBuffered });
        if (!bytes) { diagnostics.push({ index, result:'incomplete', ranges:assembled[index].parts.map(part => [part.rangeStart,part.body.length,part.headers['content-range'] || part.status]) }); continue; }
        const candidatePath = path.join(tempDir, `stream-${index}.bin`);
        await fs.writeFile(candidatePath, bytes);
        try {
          const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", candidatePath]);
          const probe = JSON.parse(stdout);
          diagnostics.push({index,result:'probed',...probe});
          if (Math.abs(Number(probe.format?.duration) - sourceEvidence.duration) > 1 || !Number(probe.format?.duration)) continue;
          const videoStream = probe.streams?.find(stream => stream.codec_type === "video");
          const hasAudio = probe.streams?.some(stream => stream.codec_type === "audio");
          if (videoStream && videoStream.width === sourceEvidence.width && videoStream.height === sourceEvidence.height) matchedVideos.push({ path: candidatePath, hasAudio });
          else if (!videoStream && hasAudio) matchedAudio.push(candidatePath);
        } catch {
          diagnostics.push({index,result:'unreadable'});
          // Ignore incomplete or duplicate streaming groups.
        }
      }
      if (matchedVideos.length !== 1) {
        await fs.writeFile(path.join(outputDir, `${shortcode}-capture-diagnostic.json`), JSON.stringify({source:sourceEvidence,streams:diagnostics},null,2));
        throw new Error(`Captured media cannot be uniquely matched to the visible source video (${matchedVideos.length} matches); refusing unrelated media; inspect ${shortcode}-capture-diagnostic.json`);
      }
      videoInput = matchedVideos[0].path;
      audioInput = matchedVideos[0].hasAudio ? videoInput : matchedAudio.length === 1 ? matchedAudio[0] : "";
      if (!audioInput) throw new Error("No unambiguous matching audio stream; refusing silent or unrelated audio");
      if (!videoInput) throw new Error("Captured Instagram fragments did not contain a complete video stream.");
      // Keep the exact unbranded audio/video locally so a later layout repair
      // never crops an already-branded render or needs to recapture the post.
      const original = path.join(outputDir, `${shortcode}-source.mp4`);
      await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", videoInput, "-i", audioInput,
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", original]);
      const sourceHandle = options.sourceHandle || new URL(reelUrl).pathname.split('/').filter(Boolean)[0];
      sourceEvidence.video_layout = await renderFootageOnly({input:original,destination,sourceHandle,
        width:sourceEvidence.width,height:sourceEvidence.height,duration:sourceEvidence.duration});

      const { stdout: probeOutput } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height,duration:format=duration",
        "-of", "json", destination
      ]);
      const probe = JSON.parse(probeOutput);
      const encodedVideo = probe.streams?.find((stream) => stream.codec_type === "video");
      const encodedAudio = probe.streams?.find((stream) => stream.codec_type === "audio");
      const duration = Number(probe.format?.duration || 0);
      if (!encodedVideo || encodedVideo.codec_name !== "h264" || encodedVideo.width !== 1080 || encodedVideo.height !== 1350) {
        throw new Error("Rendered mirror failed the required 1080x1350 H.264 validation.");
      }
      if (audioInput && (!encodedAudio || encodedAudio.codec_name !== "aac")) {
        throw new Error("Rendered mirror failed the required AAC audio validation.");
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Rendered mirror has no valid playable duration.");
      }
      if (Math.abs(duration - sourceEvidence.duration) > 1) throw new Error("Output duration does not match the caption's source video");
      for (const stream of [encodedVideo,encodedAudio]) {
        if (!Number.isFinite(Number(stream?.duration)) || Math.abs(Number(stream.duration) - sourceEvidence.duration) > 1) throw new Error('Decoded video/audio duration is incomplete; refusing a partial capture');
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    return sourceEvidence;
}

async function capture(reelUrl, options = {}) {
  if (!/^https:\/\/www\.instagram\.com\/(?:[^/]+\/)?(?:reel|p)\/[A-Za-z0-9_-]+\/?/.test(reelUrl)) {
    throw new Error("capture requires a full Instagram reel or video-post URL");
  }
  await fs.mkdir(outputDir, { recursive: true });
  const shortcode = reelUrl.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/)[1];
  const destination = path.join(outputDir, `${shortcode}.mp4`);
  const context = await launch(options.headless === true);
  try {
    const page = context.pages()[0] || await context.newPage();
    await assertRapWireLogin(page);
    const candidates = [];
    page.on("response", async (response) => {
      try {
        const headers = await response.allHeaders();
        const type = headers["content-type"] || "";
        if (!type.startsWith("video/") && !type.startsWith("audio/") && !/\.(?:mp4|webm)(?:\?|$)/i.test(response.url())) return;
        const body = await response.body();
        if (body.length) candidates.push({ body, type, url: response.url(), headers, status: response.status() });
      } catch {
        // Streaming responses may be unavailable until playback completes.
      }
    });
    await page.goto(reelUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    if (options.vip) {
      return await capturePostMedia({page, requestedUrl:reelUrl, outputDir,
        captureVideo: (video, destination, suffix) => captureVideo(page, video, candidates, reelUrl, options, destination, suffix)});
    }
    const video = page.locator("video:visible").first();
    const sourceEvidence = await captureVideo(page, video, candidates, reelUrl, options, destination, shortcode);
    const resultStat = await fs.stat(destination);
    const evidence = { ...sourceEvidence, shortcode, destination, bytes: resultStat.size, captured_at: new Date().toISOString(), media_match_method: "unique-complete-stream-duration-dimensions-v1" };
    await fs.writeFile(path.join(outputDir, `${shortcode}.json`), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify({ shortcode, destination, bytes: resultStat.size, audioCaptured: true, logoOverlay: "rapwire247-logo-bottom-left", source: reelUrl }));
    return evidence;
  } finally {
    await context.close();
  }
}

async function saveDraft(mediaPath, captionPath, publish = false) {
  const absoluteMedia = path.resolve(mediaPath);
  const caption = captionPath ? await fs.readFile(path.resolve(captionPath), "utf8") : "";
  await fs.access(absoluteMedia);
  const context = await launch(false);
  try {
    const page = context.pages()[0] || await context.newPage();
    await assertRapWireLogin(page);
    await page.getByRole("link", { name: "New post" }).click();
    const postChoice = page.getByText("Post", { exact: true });
    if (await postChoice.count()) {
      await postChoice.first().click();
      await page.waitForTimeout(800);
    }
    const chooser = page.locator('input[type="file"]');
    await chooser.waitFor({ state: "attached", timeout: 15_000 });
    await chooser.setInputFiles(absoluteMedia);
    await page.waitForTimeout(2500);

    // Instagram may show an aspect-ratio warning before the normal editor.
    const ok = page.getByRole("button", { name: /OK|Continue/i });
    if (await ok.count()) await ok.first().click().catch(() => {});
    for (let step = 0; step < 2; step += 1) {
      const next = page.getByRole("button", { name: "Next", exact: true });
      await next.waitFor({ state: "visible", timeout: 15_000 });
      await next.click();
      await page.waitForTimeout(1200);
    }

    const captionBox = page.getByRole("textbox", { name: /caption/i });
    await captionBox.waitFor({ state: "visible", timeout: 15_000 });
    if (caption.trim()) await captionBox.fill(caption.trim());

    if (publish) {
      const verifyPage = await context.newPage();
      await verifyPage.goto("https://www.instagram.com/rapwire247/", { waitUntil: "domcontentloaded" });
      await verifyPage.waitForTimeout(2000);
      const newestPost = verifyPage.locator('a[href*="/reel/"], a[href*="/p/"]').first();
      const beforeHref = await newestPost.getAttribute("href");
      const share = page.getByRole("button", { name: "Share", exact: true });
      await share.waitFor({ state: "visible", timeout: 10_000 });
      await share.click();
      let publishedHref = "";
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await page.waitForTimeout(10_000);
        await verifyPage.reload({ waitUntil: "domcontentloaded" });
        await verifyPage.waitForTimeout(1500);
        publishedHref = await verifyPage.locator('a[href*="/reel/"], a[href*="/p/"]').first().getAttribute("href") || "";
        if (publishedHref && publishedHref !== beforeHref) break;
      }
      if (!publishedHref || publishedHref === beforeHref) throw new Error("Share was clicked but no new live @rapwire247 post appeared within two minutes.");
      console.log(JSON.stringify({ status: "published", media: absoluteMedia, captionCharacters: caption.trim().length, permalink: new URL(publishedHref, "https://www.instagram.com").toString() }));
      return;
    }

    const close = page.getByRole("button", { name: /close/i }).first();
    await close.click();
    const save = page.getByRole("button", { name: /save draft/i });
    try {
      await save.waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      const controls = await page.locator("button").allTextContents();
      const bodyText = await page.locator("body").innerText();
      await page.screenshot({ path: path.join(outputDir, "draft-modal-debug.png") });
      throw new Error(`Instagram did not expose Save draft. Buttons: ${JSON.stringify(controls)}. Screen: ${bodyText.slice(0, 1200)}`);
    }
    await save.click();
    await page.waitForTimeout(1500);
    console.log(JSON.stringify({ status: "draft_saved", media: absoluteMedia, captionCharacters: caption.trim().length }));
  } finally {
    await context.close();
  }
}

export { capture, launch };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, argument] = process.argv.slice(2);
  if (command === "login") await login();
  else if (command === "capture") await capture(argument || "");
  else if (command === "draft") await saveDraft(argument || "", process.argv[4] || "");
  else if (command === "publish") await saveDraft(argument || "", process.argv[4] || "", true);
  else throw new Error("Usage: node scripts/instagram-browser-mirror.mjs <login|capture|draft|publish> [argument]");
}
