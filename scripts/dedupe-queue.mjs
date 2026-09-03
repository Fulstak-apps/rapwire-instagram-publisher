import fs from 'node:fs/promises';
import path from 'node:path';
import {storyFingerprint} from './editorial-policy.mjs';
const dir = 'queue';
const records = await Promise.all((await fs.readdir(dir)).filter(x => x.endsWith('.json')).map(async name => ({ name, item: JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) })));
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
  const fingerprint=storyFingerprint(item.body);
  const prior = seenIds.get(item.id) || (shortcode && seenVideos.get(shortcode)) || (fingerprint&&seenStories.get(fingerprint));
  const started=['instagram','threads'].some(prefix=>item[prefix+'_media_id']||item[prefix+'_container_id']||item[prefix+'_publish_requested_at']||item[prefix+'_children']?.some(Boolean));
  if (prior && item.status === 'ready' && !started) {
    item.status = 'paused'; item.pause_reason = `Duplicate of ${prior}; preserved but not republished`;
    await fs.writeFile(path.join(dir, name), JSON.stringify(item, null, 2) + '\n');
    console.log(`Duplicate held: ${name} -> ${prior}`);
  } else if (['ready', 'published'].includes(item.status)) {
    seenIds.set(item.id, name);
    if (shortcode) seenVideos.set(shortcode, name);
    if (fingerprint) seenStories.set(fingerprint,name);
  }
}
