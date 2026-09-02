// One bounded step per run. Persist before any non-idempotent publish request.
export async function advanceContainer({ item, prefix, create, inspect, publish, save, now = Date.now() }) {
  const key = suffix => `${prefix}_${suffix}`;
  if (item[key('media_id')]) return { id: item[key('media_id')], existing: true };
  if (item[key('reconcile_required')]) throw new Error(`${prefix}: uncertain publication needs reconciliation; not duplicating it`);
  if (Date.parse(item[key('retry_at')] || '') > now) return null;
  if (!item[key('container_id')]) {
    const result = await create();
    if (!result?.id) throw new Error(`${prefix}: create response missing ID`);
    item[key('container_id')] = result.id;
    item[key('container_created_at')] = new Date(now).toISOString();
    item[key('container_checked_at')] = new Date(now).toISOString();
    await save();
    return null;
  }
  if (now - Date.parse(item[key('container_checked_at')] || '') < 120_000) return null;
  const result = await inspect(item[key('container_id')]);
  const status = result.status_code || result.status;
  item[key('container_checked_at')] = new Date(now).toISOString();
  item[key('container_status')] = status;
  await save();
  if (status === 'PUBLISHED' || item[key('publish_requested_at')]) {
    item[key('reconcile_required')] = true;
    await save();
    throw new Error(`${prefix}: previous publish outcome uncertain; reconcile saved container before any retry`);
  }
  if (['ERROR', 'EXPIRED'].includes(status)) {
    const failures = Number(item[key('container_failures')] || 0) + 1;
    item[key('container_failures')] = failures;
    item[key('previous_container_id')] = item[key('container_id')];
    delete item[key('container_id')];
    delete item[key('container_checked_at')];
    item[key('retry_at')] = new Date(now + Math.min(240, 30 * 2 ** (failures - 1)) * 60_000).toISOString();
    await save();
    throw new Error(`${prefix}: ${status}; retry after ${item[key('retry_at')]}: ${result.error_message || result.status || ''}`);
  }
  if (status !== 'FINISHED') return null; // Processing time is not a failure.
  item[key('publish_requested_at')] = new Date(now).toISOString();
  await save();
  try {
    const published = await publish(item[key('container_id')]);
    if (!published?.id) throw new Error(`${prefix}: publish response missing ID`);
    item[key('media_id')] = published.id;
    item[key('published_at')] = new Date(now).toISOString();
    delete item[key('error')];
    delete item[key('retry_at')];
    await save();
    return published;
  } catch (error) {
    // Only an explicit platform rejection proves that nothing was published.
    // A timeout/connection loss must retain the marker to prevent duplicates.
    if (error.definitiveRejection) delete item[key('publish_requested_at')];
    await save();
    throw error;
  }
}
