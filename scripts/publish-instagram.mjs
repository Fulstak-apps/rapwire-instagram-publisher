import {signedCaption,refreshCaptionStyle,refreshThreadsCopy} from "./caption-style.mjs";
import {threadsTopicTag} from './audience-policy.mjs';
import fs from "node:fs/promises";
import path from "node:path";
import {advanceMediaPost} from "./carousel-state.mjs";
import {isMediaRepost, validMediaRepost} from "./repost-media-policy.mjs";
import { advanceContainer } from "./container-state.mjs";
import { captionIsBound } from "./video-caption.mjs";
import { publicationPolicy, recoveryPolicy, FEED_INTERVAL_MS, THREADS_INTERVAL_MS, FACEBOOK_INTERVAL_MS } from "./publication-policy.mjs";
import {reportingGate,editorialRank,recentPosts,contentLane} from './editorial-policy.mjs';
import {videoLayoutGate,verifyVideoLayoutFiles} from './video-layout-policy.mjs';
import {normalizeSources,sourcePostsToday} from './source-policy.mjs';
import {metaClient} from './meta-client.mjs';
import {deliverFacebookPage,facebookMedia} from './facebook-page.mjs';
import {instagramBlockKind} from './instagram-auth-state.mjs';

const instagramToken = process.env.INSTAGRAM_ACCESS_TOKEN;
const instagramUserId = process.env.INSTAGRAM_USER_ID;
const threadsToken = process.env.THREADS_ACCESS_TOKEN;
const threadsUserId = process.env.THREADS_USER_ID;
const facebookPageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const facebookPageId = process.env.FACEBOOK_PAGE_ID;
const publishInstagramStories = process.env.PUBLISH_INSTAGRAM_STORIES === "true";
const repository = process.env.GITHUB_REPOSITORY;
const refName = process.env.GITHUB_REF_NAME || "main";

if (!instagramToken || !instagramUserId || !threadsToken || !threadsUserId || !repository) {
  throw new Error("Missing Instagram/Threads credentials or GITHUB_REPOSITORY; RapWire requires both platforms");
}

const instagramBase = "https://graph.instagram.com";
const threadsBase = "https://graph.threads.net/v1.0";
const facebookConfigured=Boolean(facebookPageToken&&facebookPageId);
let facebookApi=facebookConfigured?metaClient('https://graph.facebook.com',facebookPageToken):null;
let facebookTokenResolved=!facebookConfigured;
let facebookUsingPageToken=false;

// The secret can be either a Page token or a user token granted Page access.
// Facebook requires the actual Page token for uploads (especially unpublished
// carousel children), so exchange only in memory and never write it to logs.
async function resolveFacebookPageApi() {
  if (!facebookConfigured || facebookTokenResolved) return facebookApi;
  facebookTokenResolved=true;
  try {
    const page=await facebookApi.get(`/${facebookPageId}`,{fields:'id,access_token'});
    if (page.access_token) {
      facebookApi=metaClient('https://graph.facebook.com',page.access_token);
      facebookUsingPageToken=true;
      console.log('Facebook: resolved Page-scoped publishing token');
    } else console.warn('Facebook: configured token did not return a Page-scoped publishing token');
  } catch (error) {
    // Keep the configured token as a fallback so existing Page-token setups
    // remain compatible. The later upload error is logged against its item.
    console.warn(`Facebook: Page-token resolution unavailable (${error.message})`);
  }
  return facebookApi;
}
const queueDir = "queue";
const logsDir = "logs";
const attemptsLog = path.join(logsDir, "publish-attempts.jsonl");
const cooldownPath = path.join(logsDir, "instagram-cooldown.json");
const quotaPath = path.join(logsDir, "instagram-publishing-quota.json");
const threadsCooldownPath = path.join(logsDir, 'threads-delivery-cooldown.json');
let threadsCooldown = JSON.parse(await fs.readFile(threadsCooldownPath, 'utf8').catch(error => { if(error.code==='ENOENT') return '{}'; throw error; }));
let quota = JSON.parse(await fs.readFile(quotaPath, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }));
let cooldown = JSON.parse(await fs.readFile(cooldownPath, "utf8").catch(error => {
  if (error.code === "ENOENT") return "{}";
  throw error;
}));
if (Date.parse(cooldown.until || "") > Date.now()) {
  console.log(`Instagram rate-limit cooldown until ${cooldown.until}; saved uploads retained.`);
}
const runEvents = [];
let instagramSteps = 0;
let threadsSteps = 0;
let facebookSteps = 0;
let instagramLane = "";
const instagramAvailable = () => !(Date.parse(cooldown.until || "") > Date.now()) && quota.blocked !== true;

async function checkInstagramRateLimit(response, payload) {
  if (payload.error?.code === 9 && payload.error?.error_subcode === 2207042) {
    quota = { ...quota, blocked: true, observed_rejection_at_usage: quota.usage, detected_at: new Date().toISOString(), next_check_at: new Date(Date.now() + 3600000).toISOString(), reason: "Instagram publishing quota exhausted (9/2207042)" };
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(quotaPath, JSON.stringify(quota, null, 2) + "\n");
    throw Object.assign(new Error(`Instagram publishing quota exhausted; next capacity check ${quota.next_check_at}`), { definitiveRejection: true });
  }
  if (response.status !== 429 && ![4, 17, 32, 613].includes(payload.error?.code)) return;
  const previousRecent = Date.now() - Date.parse(cooldown.detected_at || "") < 24 * 60 * 60_000;
  const strikes = previousRecent ? Number(cooldown.strikes || 0) + 1 : 1;
  const retryAfter = response.headers.get("retry-after");
  const serverDelay = Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
  const delay = Math.max(serverDelay, Math.min(240, 30 * 2 ** (strikes - 1)) * 60_000);
  cooldown = { detected_at: new Date().toISOString(), until: new Date(Date.now() + delay).toISOString(), strikes, reason: "Instagram application request limit" };
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(cooldownPath, JSON.stringify(cooldown, null, 2) + "\n");
  throw Object.assign(new Error(`Instagram rate limited; all requests deferred until ${cooldown.until}`), { definitiveRejection: true });
}

function assertInstagramAvailable() {
  if (Date.parse(cooldown.until || "") > Date.now()) throw new Error(`Instagram cooling down until ${cooldown.until}`);
  if (quota.blocked) throw new Error(`Instagram publishing deferred: ${quota.reason || 'capacity unavailable'}; next check ${quota.next_check_at}`);
}
const queueNames = (await fs.readdir(queueDir)).filter((name) => name.endsWith(".json")).sort();
const queueRecords = await Promise.all(queueNames.map(async (name) => ({
  name,
  item: JSON.parse(await fs.readFile(path.join(queueDir, name), "utf8"))
})));
const sourceRegistry=normalizeSources(JSON.parse(await fs.readFile('monitor/sources.json','utf8').catch(error=>{
  // Publisher integration fixtures intentionally contain only queue/media.
  // Production always has the registry; an absent fixture registry means no
  // source-specific cap rather than a startup failure.
  if(error.code==='ENOENT') return '{"sources":[]}'; throw error;
})));
const artistHandleRegistry=JSON.parse(await fs.readFile('monitor/artist-handles.json','utf8').catch(error=>{
  if(error.code==='ENOENT') return '[]'; throw error;
}));
const sourceByHandle=new Map(sourceRegistry.map(source=>[source.handle,source]));
const sourceFeedAllowed=item=>{
  const source=sourceByHandle.get(String(item.source_handle||'').toLowerCase());
  if(!source||source.daily_maximum===Infinity)return true;
  // Count confirmed Instagram feed posts only. The collector separately limits
  // queued items, so an unfinished cross-platform delivery cannot inflate the
  // cap or allow a third feed post.
  return sourcePostsToday(source,queueRecords.map(record=>record.item).filter(record=>record.id!==item.id&&record.instagram_media_id),Date.now()).length<source.daily_maximum;
};
const videoLayoutChecks=new WeakMap(),videoLayoutChecksByFile=new Map();
const footageOnlyAllowed=item=>videoLayoutGate(item).allowed && videoLayoutChecks.get(item)?.allowed!==false;
for (const {name,item} of queueRecords) {
  // Immutable completed history is not being uploaded again. Avoid re-reading
  // its entire video archive on every scheduled publisher run.
  const deliveryPending=['ready','published'].includes(item.status) && (!item.instagram_media_id||!item.threads_media_id
    || publishInstagramStories&&!item.instagram_story_media_id&&(item.story||item.content_type==='video'));
  const layoutCheck=deliveryPending?await verifyVideoLayoutFiles(item):videoLayoutGate(item);
  videoLayoutChecks.set(item,layoutCheck);videoLayoutChecksByFile.set(name,layoutCheck);
  // Retain every caption and publication marker on unsafe legacy assets.
  if(!layoutCheck.allowed)continue;
  const changed=refreshCaptionStyle(item,artistHandleRegistry);
  if (refreshThreadsCopy(item) || changed) await save(path.join(queueDir,name),item);
}
const recentPublications=recentPosts(queueRecords.map(x=>x.item));
const isFacebookVideoItem=item=>item.content_type==='video'
  || (Array.isArray(item.media_items) && item.media_items.length===1 && item.media_items[0]?.type==='video');
const files = queueRecords
  .sort((left, right) => {
    const readyDelta = Number(right.item.status === "ready") - Number(left.item.status === "ready");
    if (readyDelta) return readyDelta;
    const videoDelta=Number(isFacebookVideoItem(right.item))-Number(isFacebookVideoItem(left.item));
    if(videoDelta) return videoDelta;
    const priorityDelta = editorialRank(right.item,recentPublications) - editorialRank(left.item,recentPublications);
    return priorityDelta || left.name.localeCompare(right.name);
  })
  .map((record) => record.name);
// Respect the workflow's pacing limit. The newsroom may prepare a batch, but
// only the configured number of feed posts should go live in one cycle.
const maxFeedPostsPerRun = 1;
let videoAttemptsThisRun = 0;
const pacingPath = path.join(logsDir, "publisher-pacing.json");
const recoveryAuthorization = JSON.parse(await fs.readFile(path.join(logsDir, 'instagram-recovery.json'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
}));
const pacing = JSON.parse(await fs.readFile(pacingPath, "utf8").catch(error => {
  if (error.code === "ENOENT") return "{}";
  throw error;
}));
if (Date.now() - Date.parse(pacing.last_run_at || "") < 120_000) {
  console.log("Two-minute processing-check interval has not elapsed (feed cadence is 60 minutes).");
  process.exit(0);
}
await fs.mkdir(logsDir, { recursive: true });
await fs.writeFile(pacingPath, JSON.stringify({ ...pacing, last_run_at: new Date().toISOString() }) + "\n");
let feedPostsPublishedThisRun = 0;
let olderStoryAttemptsThisRun = 0;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requestTimeoutMs = 90_000;
const mediaUrl = (relativePath) => `https://raw.githubusercontent.com/${repository}/${refName}/${relativePath}`;

async function refreshQuota() {
  const recoveryItem = queueRecords.find(({item}) => item.id === recoveryAuthorization.item_id)?.item;
  const recoveryNeedsCheck = recoveryAuthorization.mode === 'one-feed-and-story'
    && Date.parse(recoveryAuthorization.expires_at || '') > Date.now()
    && recoveryItem && !recoveryItem.instagram_story_media_id && quota.blocked === false
    && Date.now() - Date.parse(quota.checked_at || '') >= 5 * 60000;
  if (Date.parse(cooldown.until || "") > Date.now() || (Date.parse(quota.next_check_at || "") > Date.now() && !recoveryNeedsCheck)) return;
  try {
    const url = new URL(`${instagramBase}/${instagramUserId}/content_publishing_limit`);
    url.searchParams.set("fields", "quota_usage,config"); url.searchParams.set("access_token", instagramToken);
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    const payload = await response.json();
    await checkInstagramRateLimit(response, payload);
    const data = payload.data?.[0];
    const usage = Number(data?.quota_usage), total = Number(data?.config?.quota_total);
    if (!response.ok || payload.error || !Number.isFinite(usage) || !Number.isFinite(total) || total <= 0) throw new Error(`Quota check unavailable: ${JSON.stringify(payload)}`);
    // Meta can reject at a lower usage than config.quota_total advertises.
    // Keep its actual rejection authoritative until usage falls below it.
    const rejectedAtUsage = quota.observed_rejection_at_usage ?? (/9\/2207042/.test(quota.reason || "") ? quota.usage : undefined);
    const effectiveTotal = rejectedAtUsage > 0 && Date.now() - Date.parse(quota.detected_at || "") < 86400000 ? Math.min(total, rejectedAtUsage) : total;
    quota = { ...quota, checked_at: new Date().toISOString(), usage, total, effective_total: effectiveTotal, observed_rejection_at_usage: rejectedAtUsage, blocked: usage >= effectiveTotal, next_check_at: new Date(Date.now() + (usage >= effectiveTotal ? 3600000 : 15 * 60000)).toISOString(), reason: usage >= effectiveTotal ? "Publishing capacity exhausted; honoring actual publish rejection" : "Capacity available" };
  } catch (error) {
    const authFailure = instagramBlockKind(error.message) === 'authentication';
    quota = { ...quota, blocked: true, next_check_at: new Date(Date.now() + (authFailure ? 5 * 60_000 : 3600000)).toISOString(), reason: error.message };
    console.error(error.message);
  }
  await fs.writeFile(quotaPath, JSON.stringify(quota, null, 2) + "\n");
}
await refreshQuota();

async function logAttempt(event) {
  runEvents.push(event);
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(attemptsLog, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
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
  if (isMediaRepost(item)) return validMediaRepost(item);
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
  const temporary = `${itemPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(item, null, 2)}\n`);
  await fs.rename(temporary, itemPath);
}

async function instagramPost(endpoint, fields, recoveryItem = null, recoveryLane = null) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertInstagramAvailable();
    const liveRecovery = recoveryItem ? recoveryPolicy([recoveryItem], {
      quota, authorization: recoveryAuthorization, lastFeedPublishedAt: pacing.last_feed_published_at
    }) : {};
    const recoveryAllowed = recoveryItem?.id === liveRecovery.item_id
      && ((recoveryLane === 'feed' && liveRecovery.feed_allowed) || (recoveryLane === 'story' && liveRecovery.story_allowed));
    if (endpoint === "media_publish" && !recoveryAllowed && Math.max(instagramPublicationsInRollingDay, Number(quota.usage) || 0) >= deliveryPolicy.instagram_daily_cap) {
      throw Object.assign(new Error("Rolling-day safety cap reached (feed plus Stories); queued for later"), { definitiveRejection: true });
    }
    const body = new URLSearchParams({ ...fields, access_token: instagramToken });
    const response = await fetch(`${instagramBase}/${instagramUserId}/${endpoint}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const payload = await response.json();
    await checkInstagramRateLimit(response, payload);
    if (response.ok && !payload.error) {
      if (endpoint === "media_publish") {
        instagramPublicationsInRollingDay += 1;
        if (Number.isFinite(quota.usage)) {
          quota.usage += 1; quota.blocked = quota.usage >= (quota.effective_total || quota.total);
          await fs.writeFile(quotaPath, JSON.stringify(quota, null, 2) + "\n");
        }
      }
      return payload;
    }
    const mediaNotReady = endpoint === "media_publish"
      && payload.error?.code === 9007
      && payload.error?.error_subcode === 2207027;
    const retryable = mediaNotReady && attempt < 2;
    if (!retryable) throw Object.assign(new Error(`${endpoint} failed: ${JSON.stringify(payload)}`), { definitiveRejection: Boolean(payload.error) && payload.error.code !== 1 && response.status < 500 });
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
  const submit = async requestFields => {
    const body = new URLSearchParams({ ...requestFields, access_token: threadsToken });
    const response = await fetch(`${threadsBase}/${threadsUserId}/${endpoint}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    return {response, payload: await response.json()};
  };
  let {response, payload} = await submit(fields);
  // Topic support varies between Threads API versions/accounts. A rejected
  // optional topic must never block the actual reporting post.
  const topicRejected = fields.topic_tag && /topic[ _-]?tag|unsupported parameter|invalid parameter/i.test(JSON.stringify(payload));
  if ((!response.ok || payload.error) && topicRejected) {
    const {topic_tag, ...withoutTopic} = fields;
    ({response, payload} = await submit(withoutTopic));
    if (response.ok && !payload.error) console.warn(`Threads ${endpoint}: topic tag unavailable; published without it`);
  }
  if (!response.ok || payload.error) throw Object.assign(new Error(`Threads ${endpoint} failed: ${JSON.stringify(payload)}`), { definitiveRejection: Boolean(payload.error) && response.status < 500 });
  return payload;
}

async function inspectContainer(platform, id) {
  if (platform === "instagram") assertInstagramAvailable();
  const url = new URL(`${platform === "instagram" ? instagramBase : threadsBase}/${id}`);
  url.searchParams.set("fields", platform === "instagram" ? "status_code,status" : "status,error_message");
  url.searchParams.set("access_token", platform === "instagram" ? instagramToken : threadsToken);
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  const payload = await response.json();
  if (platform === "instagram") await checkInstagramRateLimit(response, payload);
  if (!response.ok || payload.error) throw new Error(`${platform} status check failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function verifyPublication(item, itemPath, prefix) {
  if (item[`${prefix}_verified_at`] || !item[`${prefix}_media_id`]) return;
  const isThreads = prefix === "threads";
  if (!isThreads && !instagramAvailable()) return;
  const url = new URL(`${isThreads ? threadsBase : instagramBase}/${item[`${prefix}_media_id`]}`);
  url.searchParams.set("fields", prefix === "instagram_story" ? "id,media_type" : "id,permalink");
  url.searchParams.set("access_token", isThreads ? threadsToken : instagramToken);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    const payload = await response.json();
    if (!isThreads) await checkInstagramRateLimit(response, payload);
    if (!response.ok || payload.error || String(payload.id) !== String(item[`${prefix}_media_id`])) throw new Error(JSON.stringify(payload));
    item[`${prefix}_verified_at`] = new Date().toISOString();
    if (payload.permalink) item[`${prefix}_permalink`] = payload.permalink;
    delete item[`${prefix}_verification_error`];
  } catch (error) {
    item[`${prefix}_verification_error`] = error.message;
    await logAttempt({ id: item.id, platform: prefix, status: "verification_failed", error: error.message });
  }
  await save(itemPath, item);
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

async function publishMediaFeed(item,itemPath,platform) {
  const media = isMediaRepost(item) ? item.media_items.map(m=>({...m,url:mediaUrl(m.path)}))
    : item.slides.map((p,index)=>({type:'image',url:slideUrl(item,index)}));
  const ig=platform==='instagram';
  const create=fields=>ig?instagramPost('media',fields):threadsPost('threads',fields);
  const fields=m=>m.type==='video'?{media_type:'VIDEO',video_url:m.url}
    : ig?{image_url:m.url}:{media_type:'IMAGE',image_url:m.url};
  const copy=ig?{caption:signedCaption(item.caption,item)}:{
    text:signedCaption(item.threads_text||item.caption,item),
    topic_tag:item.threads_topic_tag||threadsTopicTag(item.body||item.threads_text||item.caption,{artistMentions:item.artist_mentions||[]})
  };
  return advanceMediaPost({item,prefix:platform,media,
    createChild:m=>create({...fields(m),is_carousel_item:'true'}),
    createSingle:m=>create({...fields(m),...copy}),
    createParent:ids=>create({media_type:'CAROUSEL',children:ids.join(','),...copy}),
    inspect:id=>inspectContainer(platform,id),
    publish:id=>ig?instagramPost('media_publish',{creation_id:id},item,'feed'):threadsPost('threads_publish',{creation_id:id}),
    save:()=>save(itemPath,item)});
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
    item.instagram_container_checked_at = new Date().toISOString();
    await save(itemPath, item);
  }
}

async function publishInstagramReel(item, itemPath) {
  assertInstagramAvailable();
  return advanceContainer({ item, prefix: "instagram",
    create: () => instagramPost("media", { media_type: "REELS", video_url: videoUrl(item), caption: signedCaption(item.caption, item), share_to_feed: "true" }),
    inspect: id => inspectContainer("instagram", id),
    publish: id => instagramPost("media_publish", { creation_id: id }, item, 'feed'),
    save: () => save(itemPath, item)
  });
}

async function publishInstagramStory(item, itemPath) {
  // Use a dedicated playable Story preview when prepared; never shorten the Reel.
  const isVideoItem = item.content_type === "video";
  if (!isVideoItem && !item.story) throw new Error("Story asset missing");
  // Recover the container ID left only inside legacy timeout errors.
  const oldId = String(item.instagram_story_error || "").match(/Instagram container (\d+) did not finish/);
  if (!item.instagram_story_container_id && oldId) {
    item.instagram_story_container_id = oldId[1];
    await save(itemPath, item);
  }
  return advanceContainer({ item, prefix: "instagram_story",
    create: () => instagramPost("media", isVideoItem
      ? { media_type: "STORIES", video_url: item.story_video ? mediaUrl(item.story_video) : videoUrl(item) }
      : { media_type: "STORIES", image_url: storyUrl(item) }),
    inspect: id => inspectContainer("instagram", id),
    publish: id => instagramPost("media_publish", { creation_id: id }, item, 'story'),
    save: () => save(itemPath, item)
  });
}

async function publishThreadsVideo(item, itemPath) {
  return advanceContainer({ item, prefix: "threads",
    create: () => threadsPost("threads", {
      media_type: "VIDEO", video_url: videoUrl(item), text: signedCaption(item.threads_text || item.caption, item),
      topic_tag:item.threads_topic_tag||threadsTopicTag(item.body||item.threads_text||item.caption,{artistMentions:item.artist_mentions||[]})
    }),
    inspect: id => inspectContainer("threads", id),
    publish: id => threadsPost("threads_publish", { creation_id: id }),
    save: () => save(itemPath, item)
  });
}

function contentPromiseIsKept(item) {
  if (!footageOnlyAllowed(item)) return false;
  if (!reportingGate(item).allowed) return false;
  const started=['instagram','threads'].some(prefix=>item[prefix+'_media_id']||item[prefix+'_container_id']||item[prefix+'_children']?.some(Boolean));
  if (!started && contentLane(item)==='gaming' && recentPublications.filter(x=>x.id!==item.id).slice(0,6).some(x=>contentLane(x)==='gaming')) return false;
  if (isMediaRepost(item)) return validMediaRepost(item);
  const headline = String(item.headline || "");
  const body = String(item.body || "");
  const words = body.trim().split(/\s+/).filter(Boolean);
  // Reposts are playable clips, not newsroom explainers.  They intentionally
  // use short captions, so applying the 45-word explainer requirement here
  // silently prevents every otherwise-valid video from publishing.
  if (item.content_type === "video") {
    if (item.caption_policy === 'vip-source-v1') return captionIsBound(item);
    return captionIsBound(item) && words.length >= 4 && /[.!?]/.test(body);
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
let instagramPublicationsInRollingDay = 0;
for (const file of files) {
  const item = JSON.parse(await fs.readFile(path.join(queueDir, file), "utf8"));
  if (item.instagram_media_id && Date.parse(item.published_at || item.instagram_published_at || "") >= rollingDayStart) instagramPublicationsInRollingDay += 1;
  if (item.instagram_story_media_id && Date.parse(item.instagram_story_published_at || "") >= rollingDayStart) instagramPublicationsInRollingDay += 1;
}
const deliveryPolicy = publicationPolicy(queueRecords.map(record => record.item), {
  quota, lastFeedPublishedAt: pacing.last_feed_published_at, includeStories: publishInstagramStories
});
const recovery = recoveryPolicy(queueRecords.map(record => record.item), {
  quota, authorization: recoveryAuthorization, lastFeedPublishedAt: pacing.last_feed_published_at
});

// One processing slot. Existing uploads retain
// their slots across runs so slow processing cannot create an upload pileup.
const instagramInFlightId = queueRecords.find(({item}) => item.status === 'ready'
  && (item.instagram_container_id || item.instagram_children?.some(Boolean))
  && !item.instagram_reconcile_required && contentPromiseIsKept(item))?.item.id;
const processingCount = instagramInFlightId ? 1 : 0;
const pendingStoryId = queueRecords.filter(({ item }) => item.status === "published"
  && footageOnlyAllowed(item)
  && (item.story || item.content_type === "video") && !item.instagram_story_media_id
  && !item.instagram_story_reconcile_required && !(Date.parse(item.instagram_story_retry_at || "") > Date.now())
  && (!/^(124|125|126|127|128|129)-/.test(item.id || "") || item.logo_position === "bottom-left"))
  .sort((a,b)=>(Date.parse(b.item.published_at||b.item.instagram_published_at||'')||0)-(Date.parse(a.item.published_at||a.item.instagram_published_at||'')||0))[0]?.item.id;
const pendingStory = publishInstagramStories && Boolean(pendingStoryId);
const preferStory = deliveryPolicy.story_allowed && !recovery.feed_allowed && pendingStory && pacing.last_instagram_lane === "feed";
const uploadSlots = instagramAvailable() && !preferStory && (deliveryPolicy.feed_allowed || recovery.feed_allowed)
  ? Math.max(0, 1 - processingCount) : 0;
const uploadCandidates = files.map(name => queueRecords.find(record => record.name === name))
  .filter(({ item }) => item.status === "ready" && item.content_type === "video"
    && sourceFeedAllowed(item)
    && (deliveryPolicy.feed_allowed || (recovery.feed_allowed && item.id === recovery.item_id))
    && !item.instagram_container_id && String(item.video || "").endsWith(".mp4")
    && !item.instagram_reconcile_required && !(Date.parse(item.instagram_retry_at || "") > Date.now())
    && (!item.publish_after || Date.parse(item.publish_after) <= Date.now())
    && item.layout_template === "rapwire-video-grid-safe-v1"
    && item.text_overflow_checked === true && item.rendered_body_text === item.body
    && item.content_claim_checked === true && item.editorial_substance_checked === true
    && contentPromiseIsKept(item) && item.source_policy_checked === true && item.rap_relevance_checked === true
    && (!/^(124|125|126|127|128|129)-/.test(item.id || "") || item.logo_position === "bottom-left"))
  .slice(0, uploadSlots);
await Promise.all(uploadCandidates.map(async ({ name, item }) => {
  try {
    instagramSteps += 1;
    instagramLane = "feed";
    await prepareInstagramReel(item, path.join(queueDir, name));
    console.log(`Prepared upload ${item.id}: ${item.instagram_container_id}`);
  } catch (error) {
    await logAttempt({ file: name, id: item.id, platform: "instagram", status: "failed", error: error.message });
  }
}));

let lastThreadsTime = Math.max(Date.parse(pacing.last_threads_published_at || '') || 0,
  ...queueRecords.map(({item}) => item.threads_media_id ? Date.parse(item.threads_published_at || '') || 0 : 0));
let lastFacebookTime = Math.max(Date.parse(pacing.last_facebook_published_at || '') || 0,
  ...queueRecords.map(({item}) => item.facebook_media_id ? Date.parse(item.facebook_published_at || '') || 0 : 0));
let facebookImagesToday=queueRecords.filter(({item})=>item.facebook_media_id && !isFacebookVideoItem(item)
  && Date.parse(item.facebook_published_at||'')>Date.now()-86400000).length;
const facebookVideoWaiting=()=>queueRecords.some(({item})=>isFacebookVideoItem(item) && !item.facebook_media_id
  && !item.facebook_reconcile_required && item.facebook_status!=='review_required'
  && ['ready','published'].includes(item.status) && footageOnlyAllowed(item));
const threadsInFlightId = queueRecords.find(({item}) => ['ready','published'].includes(item.status)
  && (item.threads_container_id || item.threads_children?.some(Boolean)) && !item.threads_media_id && !item.threads_reconcile_required && !item.threads_copy_error
  && item.rap_relevance_checked === true && contentPromiseIsKept(item)
  && (!item.publish_after || Date.parse(item.publish_after) <= Date.now())
  && (item.status !== 'ready' || (item.source_policy_checked === true
    && item.text_overflow_checked === true && item.rendered_body_text === item.body
    && item.content_claim_checked === true && item.editorial_substance_checked === true
    && (item.content_type === 'video' ? item.layout_template === 'rapwire-video-grid-safe-v1'
      : (validMediaRepost(item) || item.layout_template === 'rapwire-unified-v3' && hasPublishableVisual(item)))))
  && !(Date.parse(item.threads_retry_at || '') > Date.now()))?.item.id;

async function deliverThreads(item, itemPath, file) {
  const isVideoItem = item.content_type === 'video';
  if (Date.parse(threadsCooldown.until || '') > Date.now() || threadsSteps >= 1 || item.threads_media_id || item.threads_reconcile_required || item.threads_copy_error
    || !footageOnlyAllowed(item)
    || Date.now() - lastThreadsTime < THREADS_INTERVAL_MS
    || (threadsInFlightId && item.id !== threadsInFlightId)
    || item.rap_relevance_checked !== true || (isVideoItem && !captionIsBound(item))
    || (isMediaRepost(item) && !validMediaRepost(item))
    || Date.parse(item.threads_retry_at || '') > Date.now()
    || ![undefined,'pending','failed','skipped_for_instagram_only_post'].includes(item.threads_status)) return;
  try {
    threadsSteps += 1;
    const published = isVideoItem ? await publishThreadsVideo(item, itemPath) : await publishMediaFeed(item,itemPath,'threads');
    if (!published) {
      item.threads_status = 'pending';
    } else {
      item.threads_status = 'published';
      item.threads_media_id = published.id;
      item.threads_published_at = new Date().toISOString();
      delete item.threads_error;
      lastThreadsTime = Date.parse(item.threads_published_at);
      pacing.last_threads_published_at = item.threads_published_at;
      // Preserve the Instagram-ready state; its delivery can happen later.
      await save(itemPath, item);
      await fs.writeFile(pacingPath, JSON.stringify({ ...pacing, last_run_at: new Date().toISOString() }) + '\n');
      await logAttempt({ file, id: item.id, platform: 'threads', status: 'published', media_id: published.id });
      console.log(`Published Threads ${file}: ${published.id}`);
      await verifyPublication(item, itemPath, 'threads');
    }
  } catch (error) {
    item.threads_status = 'failed';
    item.threads_error = error.message;
    item.threads_retry_at = new Date(Date.now() + 30 * 60000).toISOString();
    // Account-wide errors affect every queued item. Do not rotate through the
    // queue and send the same rejected request for a different post each run.
    if (/API access blocked|rate.limit|request limit|maximum number of posts|too many actions/i.test(error.message)) {
      threadsCooldown={until:new Date(Date.now()+3600000).toISOString(),reason:error.message};
      await fs.writeFile(threadsCooldownPath,JSON.stringify(threadsCooldown,null,2)+'\n');
    }
    await logAttempt({ file, id: item.id, platform: 'threads', status: 'failed', error: error.message });
    console.error(`Threads failed for ${file}: ${error.message}`);
  }
  await save(itemPath, item);
}

async function deliverFacebook(item,itemPath,file) {
  if(!facebookConfigured || facebookSteps>=1 || item.facebook_verified_at || item.facebook_reconcile_required
    || item.facebook_status==='review_required' || Date.parse(item.facebook_retry_at||'')>Date.now())return;
  const pageApi=await resolveFacebookPageApi();
  // These attempts were rejected before a Page token was used. They were never
  // published, so retry them once with the correctly scoped token.
  if (facebookUsingPageToken && /publish_actions are not available|Unpublished posts must be posted to a page as the page itself/i.test(item.facebook_error||'')) {
    delete item.facebook_retry_at;
    delete item.facebook_error;
    if (item.facebook_status==='failed') item.facebook_status='pending';
  }
  const verificationOnly=Boolean(item.facebook_media_id);
  if(!verificationOnly&&Date.now()-lastFacebookTime<FACEBOOK_INTERVAL_MS)return;
  const videoItem=isFacebookVideoItem(item);
  // Facebook is a video-led channel. Let a ready Reel go first and cap the
  // supplemental photo/carousel posts at two confirmed posts per day.
  if(!verificationOnly && !videoItem && (facebookImagesToday>=2 || facebookVideoWaiting()))return;
  try {
    const result=await deliverFacebookPage({
      item,api:pageApi,pageId:facebookPageId,
      caption:signedCaption(item.caption,item),
      media:facebookMedia(item,{mediaUrl,slideUrl,videoUrl}),
      save:()=>save(itemPath,item)
    });
    if(result.status==='published') {
      facebookSteps+=1;
      lastFacebookTime=Date.parse(item.facebook_published_at);
      if(!videoItem) facebookImagesToday+=1;
      pacing.last_facebook_published_at=item.facebook_published_at;
      await fs.writeFile(pacingPath,JSON.stringify({...pacing,last_run_at:new Date().toISOString()})+'\n');
      await logAttempt({file,id:item.id,platform:'facebook',status:'published',media_id:result.id,permalink:result.permalink});
      console.log(`Published Facebook Page ${file}: ${result.id}`);
    } else if(result.status==='verified') {
      facebookSteps+=1;
      await logAttempt({file,id:item.id,platform:'facebook',status:'verified',media_id:result.id,permalink:result.permalink});
    } else if(result.status==='review_required') {
      await logAttempt({file,id:item.id,platform:'facebook',status:'review_required',reason:result.reason});
    }
  } catch(error) {
    await logAttempt({file,id:item.id,platform:'facebook',status:'failed',error:error.message});
    console.error(`Facebook failed for ${file}: ${error.message}`);
  }
  await save(itemPath,item);
}

for (const file of files) {
  const itemPath = path.join(queueDir, file);
  const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
  const layoutCheck=videoLayoutChecksByFile.get(file);
  videoLayoutChecks.set(item,layoutCheck);
  if(!layoutCheck.allowed) {
    const unfinished=['ready','published'].includes(item.status) && (!item.instagram_media_id||!item.threads_media_id
      || publishInstagramStories&&!item.instagram_story_media_id&&(item.story||item.content_type==='video'));
    if(unfinished)await logAttempt({file,id:item.id,platform:'video_layout',status:'review_required',reason:layoutCheck.issues.join('; ')});
    continue;
  }
  const reporting=reportingGate(item);
  if (!reporting.allowed) {
    item.editorial_review_required=reporting.reasons;
    await save(itemPath,item);
    continue;
  }
  const wasReady = item.status === "ready";
  const legacyRightLogo = /^(124|125|126|127|128|129)-/.test(item.id || "") && item.logo_position !== "bottom-left";
  if (item.content_type === "video" && legacyRightLogo) {
    await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "bottom_left_logo_rebuild_required" });
    continue;
  }
  const isVideoItem = item.content_type === "video";
  if (!isVideoItem && !validMediaRepost(item) && (!Array.isArray(item.slides) || item.slides.length < 2 || item.slides.length > 10)) {
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
    if ((!isVideoItem && !validMediaRepost(item) && item.layout_template !== "rapwire-unified-v3")
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
    // All content checks passed. Threads must not wait on Instagram's quota,
    // feed cadence, processing, or a failed Instagram upload.
    await deliverThreads(item, itemPath, file);
    await deliverFacebook(item,itemPath,file);
    if (!sourceFeedAllowed(item)) {
      await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "source_daily_maximum_reached" });
      continue;
    }
    if (feedPostsPublishedThisRun >= maxFeedPostsPerRun) {
      await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "run_feed_limit_reached" });
      continue;
    }
    if (!deliveryPolicy.feed_allowed && !(recovery.feed_allowed && item.id === recovery.item_id)) {
      await logAttempt({ file, id: item.id, platform: "instagram", status: "deferred", reason: "feed_cadence_or_reserved_daily_budget", next_feed_eligible_at: deliveryPolicy.next_feed_eligible_at });
      continue;
    }
    let published;
    if ((instagramInFlightId && instagramInFlightId !== item.id) || !instagramAvailable() || instagramSteps >= 1 || preferStory || item.instagram_reconcile_required || Date.parse(item.instagram_retry_at || "") > Date.now()) continue;
    if (isVideoItem) {
      if (!item.instagram_container_id || videoAttemptsThisRun >= 1) continue;
      videoAttemptsThisRun += 1;
    }
    try {
      instagramSteps += 1;
      instagramLane = "feed";
      published = isVideoItem ? await publishInstagramReel(item, itemPath) : await publishMediaFeed(item,itemPath,'instagram');
    } catch (error) {
      item.instagram_error = error.message;
      if (!(Date.parse(item.instagram_retry_at || "") > Date.now())) item.instagram_retry_at = new Date(Date.now() + 10 * 60_000).toISOString();
      await save(itemPath, item);
      await logAttempt({ file, id: item.id, platform: "instagram", status: "failed", error: error.message });
      console.error(`Instagram failed for ${file}: ${error.message}`);
      continue;
    }
    if (!published) continue;
    item.status = "published";
    item.instagram_media_id = published.id;
    delete item.instagram_error;
    item.published_at = new Date().toISOString();
    await logAttempt({ file, id: item.id, platform: "instagram", status: "published", media_id: published.id, content_type: item.content_type || "carousel" });
    await save(itemPath, item);
    pacing.last_feed_published_at = item.published_at;
    await fs.writeFile(pacingPath, JSON.stringify({ ...pacing, last_run_at: new Date().toISOString() }) + "\n");
    await verifyPublication(item, itemPath, "instagram");
    feedPostsPublishedThisRun += 1;
    console.log(`Published Instagram feed ${file}: ${published.id}`);
  }

  if (item.status !== "published") continue;

  const storyPending = !item.instagram_story_media_id && item.instagram_story_status !== "published";
  if (publishInstagramStories && instagramAvailable() && (deliveryPolicy.story_allowed || (recovery.story_allowed && item.id === recovery.item_id)) && instagramSteps < 1 && (wasReady || item.id === pendingStoryId || item.id === recovery.item_id) && (item.story || isVideoItem) && storyPending
    && !item.instagram_story_reconcile_required && !(Date.parse(item.instagram_story_retry_at || "") > Date.now())
    && (wasReady || olderStoryAttemptsThisRun < 1)) {
    if (!wasReady) olderStoryAttemptsThisRun += 1;
    try {
      instagramSteps += 1;
      instagramLane = "story";
      const published = await publishInstagramStory(item, itemPath);
      if (!published) {
        item.instagram_story_status = "pending";
      } else {
      item.instagram_story_status = "published";
      item.instagram_story_media_id = published.id;
      item.instagram_story_published_at = new Date().toISOString();
      delete item.instagram_story_error;
      await logAttempt({ file, id: item.id, platform: "instagram_story", status: "published", media_id: published.id });
      console.log(`Published Instagram Story ${file}: ${published.id}`);
      await verifyPublication(item, itemPath, "instagram_story");
      }
    } catch (error) {
      item.instagram_story_status = "failed";
      item.instagram_story_error = error.message;
      if (!(Date.parse(item.instagram_story_retry_at || "") > Date.now())) item.instagram_story_retry_at = new Date(Date.now() + 10 * 60_000).toISOString();
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

  await deliverThreads(item, itemPath, file);
  await deliverFacebook(item,itemPath,file);
}

const report = {
  checked_at: new Date().toISOString(),
  instagram_cooldown_until: instagramAvailable() ? null : cooldown.until,
  instagram_publishing_quota: quota,
  delivery_policy: { ...deliveryPolicy, next_feed_eligible_at: pacing.last_feed_published_at ? new Date(Date.parse(pacing.last_feed_published_at) + FEED_INTERVAL_MS).toISOString() : deliveryPolicy.next_feed_eligible_at },
  instagram_steps: instagramSteps, threads_steps: threadsSteps, facebook_steps: facebookSteps,
  facebook_configured: facebookConfigured,
  instagram_recovery: recovery,
  threads_next_eligible_at: lastThreadsTime ? new Date(lastThreadsTime + THREADS_INTERVAL_MS).toISOString() : null,
  facebook_next_eligible_at: lastFacebookTime ? new Date(lastFacebookTime + FACEBOOK_INTERVAL_MS).toISOString() : null,
  publications: runEvents.filter(event => event.status === "published"),
  failures: runEvents.filter(event => ["failed", "verification_failed"].includes(event.status)),
  reviews: runEvents.filter(event => event.status==='review_required'),
  note: "A completed workflow is not proof of publication. Only published media IDs confirm delivery."
};
await fs.writeFile(path.join(logsDir, "publisher-health.json"), JSON.stringify(report, null, 2) + "\n");
await fs.writeFile(pacingPath, JSON.stringify({ ...pacing, last_run_at: new Date().toISOString(), last_instagram_lane: instagramLane || pacing.last_instagram_lane }) + "\n");
const instagramBlockLabel = instagramBlockKind(quota.reason) === 'authentication'
  ? `Instagram authentication blocked. Next credential check ${quota.next_check_at}.`
  : `Instagram publishing quota blocked: ${quota.usage ?? "unknown"}/${quota.total ?? "unknown"}. Next capacity check ${quota.next_check_at}.`;
const summary = `## RapWire delivery result\n\n${report.publications.length} confirmed publication(s).\n\n${quota.blocked ? `${instagramBlockLabel}\n\n` : ""}${report.instagram_cooldown_until && Date.parse(report.instagram_cooldown_until) > Date.now() ? `Instagram cooldown until ${report.instagram_cooldown_until}.\n\n` : ""}${report.publications.map(x => `- ${x.platform}: ${x.id} — media ID ${x.media_id}`).join("\n")}\n\n${report.failures.map(x => `- FAILURE ${x.platform}: ${x.id}: ${x.error}`).join("\n")}\n\n${report.note}\n`;
console.log(summary);
if (quota.blocked && quota.reason) {
  const blockedSummary = `\nInstagram block reason: ${quota.reason}\n`;
  console.log(blockedSummary);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, blockedSummary);
}
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
if(report.reviews.length) {
  const reviewSummary=`\nVideo layout review: ${report.reviews.length} item(s) held; existing media and publication markers were preserved.\n\n${report.reviews.map(x=>`- ${x.id}: ${x.reason}`).join('\n')}\n`;
  console.log(reviewSummary);
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,reviewSummary);
}
const policySummary = `\nFeed cadence: at least ${deliveryPolicy.feed_interval_minutes} minutes between confirmed posts. Instagram budget: ${deliveryPolicy.instagram_daily_cap} feed/Story publications per rolling 24 hours; ${deliveryPolicy.instagram_remaining} available at start of run, ${deliveryPolicy.reserved_story_slots} reserved for outstanding Stories. Next feed no earlier than: ${report.delivery_policy.next_feed_eligible_at || "when capacity permits"}. Quota and processing may delay publication further.\n`;
console.log(policySummary);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, policySummary);
if (report.failures.length) process.exitCode = 1;
