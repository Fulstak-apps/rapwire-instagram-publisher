import { applyVerifiedArtistLabels, isVip, vipCaption, legacyVipBody } from './vip-policy.mjs';
import { captionVoicePrompt, composeThreads, threadsTopicTag } from './audience-policy.mjs';
export const shortcode = value => String(value || '').match(/\/(?:reel|p)\/([\w-]+)/)?.[1] || '';
export const genericCaption = value => /a new hip.hop video is|keeping the (?:hip.hop )?video feed moving|clean repost coverage|on Instagram:|newsroom schedule/i.test(String(value || ''));

export function sourceCaption({ requestedUrl, canonicalUrl, title = '', description = '', heading = '', allowSparse = false }) {
  if (!shortcode(requestedUrl) || shortcode(requestedUrl) !== shortcode(canonicalUrl)) throw new Error('Caption source does not match requested video shortcode');
  // Never use article.innerText: it also contains comments and recommendations.
  let raw = heading.trim();
  if (!raw) {
    const titleMatch = title.match(/^.*? on Instagram:\s*["“]([\s\S]+)["”]\s*$/);
    const descriptionMatch = description.match(/^[\s\S]{0,250}?:\s*["“]([\s\S]+)["”]\.?\s*$/);
    raw = titleMatch?.[1] || descriptionMatch?.[1] || '';
  }
  raw = raw.replace(/\r/g, '').trim();
  if (allowSparse) return /(?:…|\.{3})\s*$/.test(raw) ? '' : raw;
  if (raw.length < 15 || genericCaption(raw) || /(?:…|\.{3})\s*$/.test(raw)) throw new Error('Exact source caption missing, generic or truncated; needs review');
  return raw;
}

export function buildVideoCaption(raw, source, registry = []) {
  if (!raw || genericCaption(raw)) throw new Error('No video-specific caption available');
  let text = raw.replace(/https?:\/\/\S+/g, '').replace(/#(\w+)/g, (_, name) => /^(explore|explorepage|viral|viralvideo|fyp|trending)$/i.test(name) ? '' : name).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
  if (/\bAI\b/i.test(text)) throw new Error('Caption needs editorial review under the no-AI-caption rule');
  const artistCopy=applyVerifiedArtistLabels(text,registry);
  text=artistCopy.text;
  const voice=captionVoicePrompt(text,raw);
  const footer = `\n\n@rapwire247`;
  const legal = /\b(trial|court|murder|attacking|arrest|testif|testimony|fbi|wire|cross.examination|judge|lies|lied|lying|snitch|suspect|charged|plead|lawsuit|witness|prosecutor)\w*\b/i.test(text);
  const prefix = '';
  const caveat = legal ? ' Allegations are not findings of guilt.' : '';
  const limit = 490 - footer.length - source.length - 3 - prefix.length - caveat.length - (voice ? voice.length + 2 : 0);
  if (text.length > limit) {
    const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
    let fitted = '';
    for (const sentence of sentences) { if ((fitted + sentence).length > limit) break; fitted += sentence; }
    if (fitted.trim().length < 20) throw new Error('Source caption needs a factual summary; refusing mid-sentence truncation');
    text = fitted.trim();
  }
  if (text.split(/\s+/).length < 4) throw new Error('Source caption lacks usable video context');
  const body = prefix + text + (/[.!?]$/.test(text) ? '' : '.') + caveat;
  const threadsBody = composeThreads(body, {source, seed:raw, artistMentions:artistCopy.artist_mentions});
  return { body, caption: [body,voice,'@rapwire247'].filter(Boolean).join('\n\n'), threads_text: threadsBody, threads_topic_tag:threadsTopicTag(body,{artistMentions:artistCopy.artist_mentions}), artist_handles: artistCopy.artist_handles,artist_mentions:artistCopy.artist_mentions };
}

export function captionIsBound(item) {
  if (item.caption_policy === 'vip-source-v1') {
    if (!isVip(item.source_handle) || item.caption_source_shortcode !== shortcode(item.source_url)
      || !item.caption_source_shortcode || item.vip_source_checked !== true) return false;
    const expected = vipCaption(item.source_caption_text, item.source_handle, item.source_url,item.artist_mentions||[]);
    return [expected.body,legacyVipBody(item.source_caption_text,item.source_handle,item.source_url)].some(body=>item.body===body && item.rendered_body_text===body);
  }
  return item.caption_policy === 'exact-source-v1' && item.caption_source_shortcode === shortcode(item.source_url)
    && Boolean(item.caption_source_shortcode) && typeof item.source_caption_text === 'string'
    && item.source_caption_text.length >= 15 && !genericCaption(item.body);
}
