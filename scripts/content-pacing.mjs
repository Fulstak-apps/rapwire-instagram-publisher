// Keep the public feed from looking like a stream of rewrites of the same
// clip. This is deliberately conservative: it only treats two captions as
// the same story when their meaningful-word overlap is high.
const STOP_WORDS = new Set(`a an and are as at be but by for from has have he her his i in is it its just like of on or our she that the their them they this to was we were what when who why with yall you your rapwire`.split(' '));

export function meaningfulWords(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(word => !STOP_WORDS.has(word)));
}

export function storySimilarity(left, right) {
  const a = meaningfulWords(left);
  const b = meaningfulWords(right);
  if (a.size < 3 || b.size < 3) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export function isRecentStoryDuplicate(candidate, publishedItems, { now = Date.now(), windowMs = 6 * 60 * 60_000, threshold = 0.33 } = {}) {
  return (publishedItems || []).some(item => {
    const publishedAt = Date.parse(item.published_at || item.instagram_published_at || item.threads_published_at || '') || 0;
    return publishedAt >= now - windowMs && publishedAt <= now
      && storySimilarity(candidate.body || candidate.caption || '', item.body || item.caption || '') >= threshold;
  });
}
