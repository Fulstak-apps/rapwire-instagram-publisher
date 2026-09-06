import fs from 'node:fs/promises';
import path from 'node:path';

const HOUR = 60 * 60_000;
const readJson = async (file, fallback) => JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return JSON.stringify(fallback);
  throw error;
}));

const retryable = item => item.status === 'ready'
  && !item.instagram_media_id && !item.instagram_container_id && !item.instagram_reconcile_required
  && !(Date.parse(item.instagram_retry_at || '') > Date.now());

export function assessWatchdog({health = {}, items = [], now = Date.now()}) {
  const nextAt = Date.parse(health.delivery_policy?.next_feed_eligible_at || '');
  const cooldown = Date.parse(health.instagram_cooldown_until || '');
  const quotaBlocked = Boolean(health.instagram_publishing_quota?.blocked);
  const ready = items.filter(retryable);
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
  const failures = new Map((health.failures || []).map(event => [event.id, event]));
  const deferred = [];
  for (const record of records) {
    const failure = failures.get(record.item.id);
    if (!failure || record.item.instagram_container_id || record.item.instagram_reconcile_required) continue;
    const count = Number(record.item.watchdog_failures || 0) + 1;
    record.item.watchdog_failures = count;
    record.item.watchdog_last_failure = String(failure.error || 'publisher failure').slice(0, 600);
    record.item.watchdog_checked_at = new Date().toISOString();
    if (count >= 2 && retryable(record.item)) {
      record.item.status = 'paused';
      record.item.watchdog_hold_reason = 'Deferred after two definite publisher failures so the next eligible post can proceed.';
      deferred.push(record.item.id);
    }
    await fs.writeFile(record.file, `${JSON.stringify(record.item, null, 2)}\n`);
  }

  const decision = assessWatchdog({health, items: records.map(record => record.item)});
  const result = {...decision, checked_at: new Date().toISOString(), deferred};
  await fs.mkdir('logs', {recursive: true});
  await fs.writeFile('logs/publisher-watchdog.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (decision.dispatch) process.stdout.write('::notice title=RapWire watchdog::Missed feed window detected; retry publisher requested.\n');
  if (decision.dispatch && process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'dispatch=true\n');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
