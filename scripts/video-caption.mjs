export const shortcode = value => String(value || '').match(/\/(?:reel|p)\/([\w-]+)/)?.[1] || '';
export const genericCaption = value => /a new hip.hop video is|keeping the (?:hip.hop )?video feed moving|clean repost coverage|on Instagram:|newsroom schedule/i.test(String(value || ''));
// These biographical "is what happens" essays have repeatedly been copied
// from source pages and do not describe the specific video.  Treat them as
// unusable source copy rather than restyling and publishing the same premise.
export const staleBoilerplateCaption = value => /\bis what happens when\b|\binstead of letting (?:it|their environment) define\b/i.test(String(value || ''));

export function sourceCaption({ requestedUrl, canonicalUrl, title = '', description = '', heading = '', allowSparse = false }) {
  if (!shortcode(requestedUrl) || shortcode(requestedUrl) !== shortcode(canonicalUrl)) throw new Error('Caption source does not match requested video shortcode');
  let raw = heading.trim();
  if (!raw) {
    const titleMatch = title.match(/^.*? on Instagram:\s*["“]([\s\S]+)["”]\s*$/);
    const descriptionMatch = description.match(/^[\s\S]{0,250}?:\s*["“]([\s\S]+)["”]\.?\s*$/);
    raw = titleMatch?.[1] || descriptionMatch?.[1] || '';
  }
  raw = raw.replace(/\r/g, '').trim();
  // VIP pages can expose a deliberately sparse caption. Keep exact-post
  // identity strict, but do not invent copy for an emoji/short statement.
  // An ellipsis means the wrapper is visibly truncated, so return an empty
  // value and let the VIP policy decide whether to publish it.
  if (allowSparse) {
    if (/(?:…|\.{3})\s*$/.test(raw)) return '';
    return raw;
  }
  if (raw.length < 15 || genericCaption(raw) || staleBoilerplateCaption(raw) || /(?:…|\.{3})\s*$/.test(raw)) throw new Error('Exact source caption is generic, boilerplate, or truncated; needs review');
  return raw;
}

export function buildVideoCaption(raw, source, registry = []) {
  if (!raw || genericCaption(raw) || staleBoilerplateCaption(raw)) throw new Error('No specific, non-boilerplate video caption available');
  let text = raw.replace(/https?:\/\/\S+/g, '').replace(/#(\w+)/g, (_, name) => /^(explore|explorepage|viral|viralvideo|fyp|trending)$/i.test(name) ? '' : name).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
  if (/\bAI\b/i.test(text)) throw new Error('Caption needs editorial review under the no-AI-caption rule');
  const verified = registry.filter(person => Date.now() - Date.parse(person.verified_at || '') < 30 * 86400000 && /^https:\/\/www\.instagram\.com\//.test(person.verified_url || ''));
  const used = [];
  for (const person of verified) {
    const aliases = [person.name, ...(person.aliases || []), person.handle];
    const flags = person.case_sensitive ? '' : 'i';
    const alias = aliases.find(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags).test(text));
    if (!alias) continue;
    used.push(person.handle);
    if (!text.toLowerCase().includes(`@${person.handle.toLowerCase()}`)) {
      text = text.replace(new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags), `${person.name} @${person.handle}`);
    }
  }
  text = text.replace(/@[A-Za-z0-9_.]+/g, handle => verified.some(p => `@${p.handle}`.toLowerCase() === handle.toLowerCase()) ? handle : '').replace(/\s+/g, ' ').trim();
  // Provenance stays in the private queue record. Public repost copy carries
  // only the RapWire identity; source-page handles must never leak into it.
  const footer = `\n\n@rapwire247`;
  const legal = /\b(trial|court|murder|attacking|arrest|testif|testimony|fbi|wire|cross.examination|judge|lies|lied|lying|snitch|suspect|charged|plead|lawsuit|witness|prosecutor)\w*\b/i.test(text);
  const prefix = '';
  const caveat = legal ? ' Allegations are not findings of guilt.' : '';
  const limit = 490 - footer.length - prefix.length - caveat.length;
  if (text.length > limit) {
    const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
    let fitted = '';
    for (const sentence of sentences) { if ((fitted + sentence).length > limit) break; fitted += sentence; }
    if (fitted.trim().length < 20) throw new Error('Source caption needs a factual summary; refusing mid-sentence truncation');
    text = fitted.trim();
  }
  if (text.split(/\s+/).length < 4) throw new Error('Source caption lacks usable video context');
  const body = prefix + text + (/[.!?]$/.test(text) ? '' : '.') + caveat;
  return { body, caption: body + footer, artist_handles: used };
}

export function captionIsBound(item) {
  if (typeof item.body !== 'string' || item.body.trim().split(/\s+/).length < 4) return false;
  if (item.caption_policy === 'vip-source-v1') {
    const sourceHandle = String(item.source_handle || '').replace(/^@/, '').toLowerCase();
    const recordedHandle = String(item.caption_source_handle || '').replace(/^@/, '').toLowerCase();
    return Boolean(sourceHandle) && (!recordedHandle || recordedHandle === sourceHandle)
      && item.vip_source_checked === true
      && item.caption_source_shortcode === shortcode(item.source_url)
      && Boolean(item.caption_source_shortcode)
      && (typeof item.source_caption_text === 'undefined' || typeof item.source_caption_text === 'string')
      && typeof item.body === 'string' && typeof item.rendered_body_text === 'string'
      && item.rendered_body_text === item.body
      && !genericCaption(item.body) && !staleBoilerplateCaption(item.body)
      && !/\bAI\b/i.test(item.body);
  }
  return item.caption_policy === 'exact-source-v1' && item.caption_source_shortcode === shortcode(item.source_url)
    && Boolean(item.caption_source_shortcode) && typeof item.source_caption_text === 'string'
    && item.source_caption_text.length >= 15 && !genericCaption(item.body) && !staleBoilerplateCaption(item.body);
}
