// User instruction, 2026-09-02: repost everything from these pages until changed.
export const VIP_HANDLES = new Set(['akademiks', 'traploreross']);
export const isVip = handle => VIP_HANDLES.has(String(handle || '').replace(/^@/, '').toLowerCase());

export function rememberVip(ledger, discovered, now = Date.now()) {
  ledger.vip_pending ||= {};
  for (const item of discovered) {
    if (!isVip(item.source.handle) || ledger.queued_shortcodes[item.shortcode]) continue;
    ledger.vip_pending[item.shortcode] ||= {
      source_handle: item.source.handle, source_url: item.url, shortcode: item.shortcode,
      first_seen_at: new Date(now).toISOString(), profile_position: item.profilePosition,
      state: 'pending', attempts: 0
    };
  }
  for (const code of Object.keys(ledger.vip_pending)) {
    if (ledger.queued_shortcodes[code]) delete ledger.vip_pending[code];
  }
}

export function vipCandidates(ledger, sources, now = Date.now()) {
  return Object.values(ledger.vip_pending || {})
    .filter(x => isVip(x.source_handle) && !ledger.queued_shortcodes[x.shortcode]
      && !(Date.parse(x.retry_at || '') > now))
    .sort((a,b) => (a.attempts || 0) - (b.attempts || 0) || a.first_seen_at.localeCompare(b.first_seen_at)
      || a.profile_position - b.profile_position || a.source_handle.localeCompare(b.source_handle))
    .map(x => ({source:sources.find(s=>s.handle===x.source_handle),url:x.source_url,shortcode:x.shortcode,profilePosition:x.profile_position}))
    .filter(x=>x.source);
}

export function deferVip(ledger, candidate, error, now = Date.now()) {
  const entry = ledger.vip_pending?.[candidate.shortcode];
  if (!entry) return;
  entry.attempts = (entry.attempts || 0) + 1;
  entry.state = 'retry_pending';
  entry.last_error = String(error?.message || error).slice(0,1000);
  entry.last_attempt_at = new Date(now).toISOString();
  entry.retry_at = new Date(now + Math.min(60, 2 ** Math.min(entry.attempts,6)) * 60000).toISOString();
}

export function vipCaption(raw, source, url) {
  if (!isVip(source)) throw new Error('VIP caption policy requires a configured VIP page');
  // Attribute the source, do not interpret, summarize or fact-certify its claims.
  const text = String(raw || '').trim();
  const lead = `Reposted from @${source}.`;
  const full = `${lead}\n\n${text}\n\nOriginal post: ${url}`;
  const body = text && full.length <= 2050 ? `${lead}\n\n${text}` : lead;
  const caption = `${body}\n\nOriginal post: ${url}`;
  const threads = caption.length <= 400 ? caption : `${lead}\n\nFull caption and original post: ${url}`;
  return {body, caption, threads_text:threads, artist_handles:[]};
}
