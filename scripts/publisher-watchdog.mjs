import fs from 'node:fs/promises';
import path from 'node:path';

const readJson = async (file, fallback) => JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return JSON.stringify(fallback);
  throw error;
}));

const retryable = (item, now) => item.status === 'ready'
  && !item.instagram_media_id && !item.instagram_container_id && !item.instagram_reconcile_required
  && !item.instagram_publish_requested_at
  && !(Date.parse(item.instagram_retry_at || '') > now);

export function assessWatchdog({health = {}, items = [], now = Date.now()}) {
  const nextAt = Date.parse(health.delivery_policy?.next_feed_eligible_at || '');
  const cooldown = Date.parse(health.instagram_cooldown_until || '');
  const quotaBlocked = Boolean(health.instagram_publishing_quota?.blocked);
  const ready = items.filter(item => retryable(item, now));
  const overdue = Number.isFinite(nextAt) && now > nextAt + 15 * 60_000;
  const blocked = quotaBlocked || (Number.isFinite(cooldown) && cooldown > now);
  return {
    overdue,
    blocked,
    ready: ready.map(item => item.id),
    dispatch: overdue && !blocked && ready.length > 0,
    reason: blocked ? 'platform_cooldown_or_quota' : overdue ? (ready.length ? 'missed_feed_window' : 'no_eligible_item') : 'within_pacing_window'
  };
}

async function main() {
  const queueDir = 'queue';
  const health = await readJson('logs/publisher-health.json', {});
  const names = (await fs.readdir(queueDir)).filter(name => name.endsWith('.json'));
  const records = await Promise.all(names.map(async name => ({name, file: path.join(queueDir, name), item: await readJson(path.join(queueDir, name), {})})));

  // A definite, repeated failure should not let one bad item halt the entire
  // feed. Never alter uncertain containers: those require reconciliation to
  // avoid duplicate posts.
  const deferred = [];
  // Health is a snapshot, not a stream of distinct failures. Never count it
  // repeatedly or pause the whole item for a single platform's failure.
  // The publisher owns platform-specific retries and reconciliation; keeping
  // this check read-only also avoids racing the collector's queue writes.

  const decision = assessWatchdog({health, items: records.map(record => record.item)});
  const result = {...decision, checked_at: new Date().toISOString(), deferred};
  await fs.mkdir('logs', {recursive: true});
  await fs.writeFile('logs/publisher-watchdog.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (decision.dispatch) process.stdout.write('::notice title=RapWire watchdog::Missed feed window detected; retry publisher requested.\n');
  if (decision.dispatch && process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'dispatch=true\n');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
