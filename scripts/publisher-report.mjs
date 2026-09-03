import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(path.join(root, file), 'utf8')); }
  catch { return fallback; }
};

const queueDir = path.join(root, 'queue');
const names = (await fs.readdir(queueDir).catch(() => [])).filter(name => name.endsWith('.json'));
const items = [];
for (const name of names) {
  try { items.push({ file: name, ...(JSON.parse(await fs.readFile(path.join(queueDir, name), 'utf8'))) }); }
  catch { /* normal validation reports malformed queue files */ }
}

const statusCounts = items.reduce((out, item) => {
  const status = item.status || 'unknown';
  out[status] = (out[status] || 0) + 1;
  return out;
}, {});
const sourceCounts = items.reduce((out, item) => {
  if (item.source_handle) out[item.source_handle] = (out[item.source_handle] || 0) + 1;
  return out;
}, {});
const latestPublications = items
  .filter(item => item.instagram_media_id || item.threads_media_id)
  .sort((a, b) => String(b.published_at || b.instagram_published_at || '').localeCompare(String(a.published_at || a.instagram_published_at || '')))
  .slice(0, 10)
  .map(item => ({ id: item.id, source: item.source_handle, instagram: item.instagram_media_id || null, threads: item.threads_media_id || null, published_at: item.published_at || item.instagram_published_at || null }));
const recentFailures = items
  .filter(item => item.last_error || item.publish_error || item.caption_review_error)
  .slice(-20)
  .map(item => ({ id: item.id, status: item.status, error: item.last_error || item.publish_error || item.caption_review_error }));

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  queue_total: items.length,
  status_counts: statusCounts,
  source_counts: sourceCounts,
  latest_publications: latestPublications,
  recent_failures: recentFailures,
  audience_growth: (await readJson('logs/growth-feedback.json', {})).summary || null,
  replies: await readJson('logs/threads-replies.json', null),
  publisher_health: await readJson('logs/publisher-health.json', null),
  monitor_health: await readJson('logs/repost-monitor-health.json', null),
}, null, 2));
