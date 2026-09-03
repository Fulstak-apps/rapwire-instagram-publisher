// User instruction, 2026-09-02: repost everything from these pages until changed.
export const VIP_HANDLES = new Set(['akademiks', 'traploreross']);
export const isVip = handle => VIP_HANDLES.has(String(handle || '').replace(/^@/, '').toLowerCase());

export function discussionPrompt(text) {
  const value = String(text || '').toLowerCase();
  if (/trial|court|judge|fbi|arrest|charged|plead|testif|witness/.test(value)) return 'What detail should people be watching next?';
  if (/album|single|song|mixtape|release|tour|concert/.test(value)) return 'Does this change the conversation around the music?';
  if (/beef|diss|argument|fight|clash|controvers/.test(value)) return 'What is the key question in this situation?';
  return 'How are you reading this moment?';
}

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
  if (/\bAI\b/i.test(text)) throw new Error('Caption contains a blocked term and needs review');
  // The source page is retained in metadata, but its handle is not shown in
  // the public repost caption for these user-requested accounts.
  const body = text && text.length <= 2050 ? text : '';
  const caption = body;
  const prompt = discussionPrompt(text);
  const threads = caption.length + prompt.length + 2 <= 500 ? `${caption}\n\n${prompt}` : text.slice(0, Math.max(0, 500 - prompt.length - 2)) + `\n\n${prompt}`;
  return {body, caption, threads_text:threads, artist_handles:[]};
}

// Accept only the exact prior format while older queued items migrate.
export function legacyVipBody(raw,source,url) {
  const text=String(raw||'').trim();
  return text && text.length<=2050 ? text : '';
}
