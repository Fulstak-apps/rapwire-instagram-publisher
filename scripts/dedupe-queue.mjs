import fs from 'node:fs/promises';
import path from 'node:path';
import {storyFingerprint} from './editorial-policy.mjs';
const dir = 'queue';
const records = [];
for (const name of (await fs.readdir(dir)).filter(x => x.endsWith('.json'))) {
  try {
    const item = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('queue record is not an object');
    records.push({name, item});
  } catch (error) {
    // A partially-written collector file must not stop the entire publisher.
    // The publisher itself will report the item as unreadable and the next
    // collector pass can replace it; leave the file untouched for recovery.
    console.error(`Skipping unreadable queue item ${name}: ${error.message}`);
  }
}
const seenIds = new Map();
const seenVideos = new Map();
const seenStories = new Map();
// Published originals and in-flight containers take precedence over duplicate files.
const live=item=>Boolean(item.instagram_media_id||item.threads_media_id);
const active=item=>Boolean(item.instagram_container_id||item.threads_container_id||item.instagram_publish_requested_at||item.threads_publish_requested_at||item.instagram_children?.some(Boolean)||item.threads_children?.some(Boolean));
records.sort((a, b) => Number(live(b.item)) - Number(live(a.item))
  || Number(active(b.item)) - Number(active(a.item))
  || a.name.localeCompare(b.name, 'en', { numeric: true }));
for (const { name, item } of records) {
  const shortcode = (item.content_type === 'video' || item.type === 'source_media_repost') ? String(item.source_url || '').match(/\/(?:p|reel)\/([\w-]+)/)?.[1] : null;
  const isVideo = Boolean(shortcode);
  const fingerprint=storyFingerprint(item.body);
  // Video filenames and generated IDs often share the same headline.  Those are
  // not duplicates unless they resolve to the exact same Instagram shortcode.
  // Text/editorial records still use ID/body fingerprints for deduplication.
  const prior = isVideo
    ? (shortcode && seenVideos.get(shortcode))
    : (seenIds.get(item.id) || (fingerprint && seenStories.get(fingerprint)));
  const started=['instagram','threads'].some(prefix=>item[prefix+'_media_id']||item[prefix+'_container_id']||item[prefix+'_publish_requested_at']||item[prefix+'_children']?.some(Boolean));
  if (prior && item.status === 'ready' && !started) {
    item.status = 'paused'; item.pause_reason = `Duplicate of ${prior}; preserved but not republished`;
    await fs.writeFile(path.join(dir, name), JSON.stringify(item, null, 2) + '\n');
    console.log(`Duplicate held: ${name} -> ${prior}`);
  } else if (['ready', 'published'].includes(item.status)) {
    if (isVideo) seenVideos.set(shortcode, name);
    else {
      seenIds.set(item.id, name);
      if (fingerprint) seenStories.set(fingerprint,name);
    }
  }
}
