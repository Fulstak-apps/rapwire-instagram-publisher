import { captionVoicePrompt, composeThreads, threadsTopicTag } from './audience-policy.mjs';
import {cleanPublicCopy} from './editorial-policy.mjs';
export { discussionPrompt, fitDiscussionText } from './audience-policy.mjs';
// User instruction, 2026-09-02: repost everything from these pages until changed.
export const VIP_HANDLES = new Set(['akademiks', 'traploreross', 'records', 'darnellwilliams']);
export const isVip = handle => VIP_HANDLES.has(String(handle || '').replace(/^@/, '').toLowerCase());

export function applyVerifiedArtistLabels(value, registry = [], now = Date.now()) {
  let text=String(value||'').trim();
  const verified=registry.filter(person=>person?.name && /^[A-Za-z0-9._]+$/.test(person.handle||'')
    && now-Date.parse(person.verified_at||'')<30*86400000
    && /^https:\/\/www\.instagram\.com\/[A-Za-z0-9._]+\/?$/i.test(person.verified_url||''));
  const mentions=[];
  for(const person of verified) {
    const aliases=[person.name,...(person.aliases||[])].filter(Boolean);
    const flags=person.case_sensitive?'':'i';
    const alias=aliases.find(name=>new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,flags).test(text));
    if(!alias) continue;
    const label=`${person.name} @${person.handle}`;
    if(!new RegExp(`@${String(person.handle).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(text))
      text=text.replace(new RegExp(`\\b${String(alias).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,flags),label);
    mentions.push(person);
  }
  // Never guess that a source-page or unknown handle belongs to the person.
  // Removing only the @handle leaves an adjacent written artist name intact.
  text=text.replace(/@[A-Za-z0-9_.]+/g,handle=>verified.some(person=>`@${person.handle}`.toLowerCase()===handle.toLowerCase())?handle:'')
    .replace(/\s+/g,' ').trim();
  return {text,artist_handles:[...new Set(mentions.map(person=>person.handle))],artist_mentions:mentions};
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

export function vipCaption(raw, source, url, registry = []) {
  if (!isVip(source)) throw new Error('VIP caption policy requires a configured VIP page');
  // Attribute the source, do not interpret, summarize or fact-certify its claims.
  const artistCopy=applyVerifiedArtistLabels(cleanPublicCopy(raw,source),registry);
  const text = artistCopy.text;
  if (/\bAI\b/i.test(text)) throw new Error('Caption contains a blocked term and needs review');
  // The source page is retained in metadata, but its handle is not shown in
  // the public repost caption for these user-requested accounts.
  let body = text && text.length <= 2050 ? text : '';
  if (body && String(source).replace(/^@/,'').toLowerCase()==='darnellwilliams'
    && !/@darnellwilliams\b/i.test(body)) body = `${body}\n\nDarnell Williams @darnellwilliams`;
  const caption = [body,captionVoicePrompt(body,url)].filter(Boolean).join('\n\n');
  const threads = composeThreads(caption, {source, seed:url || text, artistMentions:artistCopy.artist_mentions});
  return {body, caption, threads_text:threads, threads_topic_tag:threadsTopicTag(body,{artistMentions:artistCopy.artist_mentions}), artist_handles:artistCopy.artist_handles,artist_mentions:artistCopy.artist_mentions};
}

// Accept only the exact prior format while older queued items migrate.
export function legacyVipBody(raw,source,url) {
  const text=String(raw||'').trim();
  return text && text.length<=2050 ? text : '';
}
