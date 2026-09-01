import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = path.join(os.homedir(), "Library", "Application Support", "RapWire", "InstagramMirrorProfile");
const outputDir = path.resolve("work", "instagram-mirror");

async function launch(headless = false) {
  await fs.mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true
  });
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

async function capture(reelUrl) {
  if (!/^https:\/\/www\.instagram\.com\/(?:[^/]+\/)?(?:reel|p)\/[A-Za-z0-9_-]+\/?/.test(reelUrl)) {
    throw new Error("capture requires a full Instagram reel or video-post URL");
  }
  await fs.mkdir(outputDir, { recursive: true });
  const shortcode = reelUrl.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/)[1];
  const isRapListed = /instagram\.com\/raplisted_\//i.test(reelUrl);
  const destination = path.join(outputDir, `${shortcode}.mp4`);
  const context = await launch(false);
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
        if (body.length) candidates.push({ body, type, url: response.url(), headers });
      } catch {
        // Streaming responses may be unavailable until playback completes.
      }
    });
    await page.goto(reelUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const video = page.locator("video").first();
    await video.waitFor({ state: "visible", timeout: 15_000 });
    await video.click().catch(() => {});
    await page.waitForTimeout(12_000);
    if (!candidates.length) throw new Error("No authenticated video response was captured from Instagram.");
    const groups = new Map();
    for (const item of candidates) {
      const parsed = new URL(item.url);
      const rangeStart = Number(parsed.searchParams.get("bytestart") || item.headers["content-range"]?.match(/bytes (\d+)-/)?.[1] || 0);
      parsed.searchParams.delete("bytestart");
      parsed.searchParams.delete("byteend");
      const key = parsed.toString();
      const group = groups.get(key) || [];
      if (!group.some((part) => part.rangeStart === rangeStart)) group.push({ ...item, rangeStart });
      groups.set(key, group);
    }
    const assembled = [...groups.values()]
      .map((parts) => ({ parts: parts.sort((a, b) => a.rangeStart - b.rangeStart), bytes: parts.reduce((sum, part) => sum + part.body.length, 0) }))
      .sort((a, b) => b.bytes - a.bytes);
    const tempDir = await fs.mkdtemp(path.join(outputDir, `${shortcode}-`));
    let videoInput = "";
    let audioInput = "";
    try {
      for (let index = 0; index < assembled.length; index += 1) {
        const candidatePath = path.join(tempDir, `stream-${index}.bin`);
        await fs.writeFile(candidatePath, Buffer.concat(assembled[index].parts.map((part) => part.body)));
        try {
          const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", candidatePath]);
          const types = JSON.parse(stdout).streams?.map((stream) => stream.codec_type) || [];
          if (!videoInput && types.includes("video")) videoInput = candidatePath;
          if (!audioInput && types.includes("audio")) audioInput = candidatePath;
        } catch {
          // Ignore incomplete or duplicate streaming groups.
        }
      }
      if (!videoInput) throw new Error("Captured Instagram fragments did not contain a complete video stream.");
      const ffmpegArgs = ["-y", "-i", videoInput];
      if (audioInput) ffmpegArgs.push("-i", audioInput);
      const logoInputIndex = audioInput ? 2 : 1;
      ffmpegArgs.push("-loop", "1", "-i", path.resolve("assets", "rapwire247-video-bug.png"));
      const videoFilter = isRapListed
        ? `[0:v]drawbox=x=0:y=ih*0.12:w=iw*0.80:h=ih*0.11:color=black:t=fill[clean];[clean]split=2[base][front];[base]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,gblur=sigma=28[blurred];[front]scale=860:1020:force_original_aspect_ratio=decrease[safe];[blurred][safe]overlay=(W-w)/2:(H-h)/2[framed];[${logoInputIndex}:v]scale=360:79[bug];[framed][bug]overlay=x=250:y=270:shortest=1[v]`
        : `[0:v]split=2[base][front];[base]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,gblur=sigma=28[blurred];[front]scale=860:1020:force_original_aspect_ratio=decrease[safe];[blurred][safe]overlay=(W-w)/2:(H-h)/2[framed];[${logoInputIndex}:v]scale=300:66[bug];[framed][bug]overlay=x=120:y=1100:shortest=1[v]`;
      ffmpegArgs.push(
        "-filter_complex",
        videoFilter,
        "-map", "[v]"
      );
      if (audioInput) ffmpegArgs.push("-map", "1:a:0");
      ffmpegArgs.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
      if (audioInput) ffmpegArgs.push("-c:a", "aac");
      else ffmpegArgs.push("-an");
      ffmpegArgs.push("-shortest");
      ffmpegArgs.push("-movflags", "+faststart", destination);
      await execFileAsync("ffmpeg", ffmpegArgs);

      const { stdout: probeOutput } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format=duration",
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
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    const resultStat = await fs.stat(destination);
    console.log(JSON.stringify({ shortcode, destination, bytes: resultStat.size, audioCaptured: Boolean(audioInput), raplistedTopCropApplied: isRapListed, source: reelUrl }));
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

const [command, argument] = process.argv.slice(2);
if (command === "login") await login();
else if (command === "capture") await capture(argument || "");
else if (command === "draft") await saveDraft(argument || "", process.argv[4] || "");
else if (command === "publish") await saveDraft(argument || "", process.argv[4] || "", true);
else throw new Error("Usage: node scripts/instagram-browser-mirror.mjs <login|capture|draft|publish> [argument]");
