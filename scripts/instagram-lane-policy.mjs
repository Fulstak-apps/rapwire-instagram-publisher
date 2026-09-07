export function storyCanRun(item, now = Date.now()) {
  return item.status === 'published' && !item.instagram_story_media_id
    && !['published', 'review_required'].includes(item.instagram_story_status)
    && !item.instagram_story_reconcile_required
    && !(Date.parse(item.instagram_story_retry_at || '') > now)
    && !(Date.parse(item.publish_after || '') > now);
}

export function shouldPreferStory({storyAllowed, feedAllowed, recoveryFeedAllowed, pendingStory, lastLane}) {
  // Stories fill the feed pacing window; they must never starve an overdue feed.
  return storyAllowed && !feedAllowed && !recoveryFeedAllowed && pendingStory && lastLane === 'feed';
}
