export const FEED_INTERVAL_MS = 30 * 60_000;
export const DAILY_INSTAGRAM_CAP = 32;

// Cadence is measured from confirmed publication, not scheduler wakeups.
// Count feed and Stories together and reserve room for outstanding Stories.
export function publicationPolicy(records, { quota = {}, lastFeedPublishedAt, includeStories = true, now = Date.now() } = {}) {
  const cutoff = now - 86400000;
  const published = new Set();
  const pendingStories = new Set();
  let lastFeed = Date.parse(lastFeedPublishedAt || '') || 0;
  for (const item of records) {
    if (item.instagram_media_id) {
      const time = Date.parse(item.published_at || item.instagram_published_at || '') || 0;
      lastFeed = Math.max(lastFeed, time);
      if (time > cutoff) published.add(item.instagram_media_id);
      if (includeStories && item.status === 'published' && (item.content_type === 'video' || item.story)
        && !item.instagram_story_media_id && item.instagram_story_status !== 'published') pendingStories.add(item.instagram_media_id);
    }
    if (item.instagram_story_media_id && Date.parse(item.instagram_story_published_at || '') > cutoff) published.add(item.instagram_story_media_id);
  }
  const platformLimit = Number(quota.effective_total || quota.total);
  const cap = Number.isFinite(platformLimit) && platformLimit > 0 ? Math.min(DAILY_INSTAGRAM_CAP, Math.floor(platformLimit * 0.8)) : DAILY_INSTAGRAM_CAP;
  const usage = Math.max(published.size, Number(quota.usage) || 0);
  const remaining = Math.max(0, cap - usage);
  const nextFeed = lastFeed ? lastFeed + FEED_INTERVAL_MS : 0;
  const neededForFeed = 1 + (includeStories ? 1 : 0) + pendingStories.size;
  return {
    feed_interval_minutes: FEED_INTERVAL_MS / 60000,
    instagram_daily_cap: cap,
    instagram_usage: usage,
    instagram_remaining: remaining,
    reserved_story_slots: pendingStories.size,
    next_feed_eligible_at: nextFeed ? new Date(nextFeed).toISOString() : null,
    feed_allowed: now >= nextFeed && remaining >= neededForFeed,
    story_allowed: remaining > 0
  };
}
