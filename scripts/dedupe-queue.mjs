import fs from 'node:fs/promises';
import path from 'node:path';
const dir = 'queue';
const records = await Promise.all((await fs.readdir(dir)).filter(x => x.endsWith('.json')).map(async name => ({ name, item: JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) })));
const seenIds = new Map();
const seenVideos = new Map();
// Published originals and in-flight containers take precedence over duplicate files.
records.sort((a, b) => Number(Boolean(b.item.instagram_media_id)) - Number(Boolean(a.item.instagram_media_id))
  || Number(Boolean(b.item.instagram_container_id)) - Number(Boolean(a.item.instagram_container_id))
  || a.name.localeCompare(b.name, 'en', { numeric: true }));
for (const { name, item } of records) {
  const shortcode = (item.content_type === 'video' || item.type === 'source_media_repost') ? String(item.source_url || '').match(/\/(?:p|reel)\/([\w-]+)/)?.[1] : null;
  const prior = seenIds.get(item.id) || (shortcode && seenVideos.get(shortcode));
  if (prior && item.status === 'ready' && !item.instagram_media_id && !item.instagram_container_id) {
    item.status = 'paused'; item.pause_reason = `Duplicate of ${prior}; preserved but not republished`;
    await fs.writeFile(path.join(dir, name), JSON.stringify(item, null, 2) + '\n');
    console.log(`Duplicate held: ${name} -> ${prior}`);
  } else if (['ready', 'published'].includes(item.status)) {
    seenIds.set(item.id, name);
    if (shortcode) seenVideos.set(shortcode, name);
  }
}
