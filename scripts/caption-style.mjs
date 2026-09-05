import {captionIsBound} from './video-caption.mjs';
import {applyVerifiedArtistLabels,vipCaption} from './vip-policy.mjs';
import {composeThreads, editorialTopic, threadsTopicTag} from './audience-policy.mjs';
import {cleanPublicCopy} from './editorial-policy.mjs';

export function signedCaption(value,item={}) {
  const source=String(item.source_handle||'').replace(/^@/,'').toLowerCase();
  let text=cleanPublicCopy(value,source)
    .replace(/(?:\n\n)?Rap\s*Wire 24\/7\.?\s*\n@Rapwire247(?:\s*\n@[A-Za-z0-9_.]+)?\s*$/i,'')
    .replace(/(?:\n\n)?Rap\s*Wire 24\/7\.?\s*$/i,'')
    .replace(/(?:\n\n)?@Rapwire247\s*$/i,'')
    .replace(/^Reposted from @[A-Za-z0-9_.]+\.\s*/i,'')
    .replace(/^Source commentary:\s*/i,'').trim();
  // Remove source labels, but preserve standalone verified artist mentions.
  text=text.split('\n').filter(line=>![`@${source}`,'@rapwire247'].includes(line.trim().toLowerCase())).join('\n').trim();
  return [text,'@rapwire247'].filter(Boolean).join('\n\n');
}

export function refreshThreadsCopy(item) {
  if (item.threads_copy_policy === 'discussion-v2' || item.threads_media_id
    || item.threads_publish_requested_at || item.threads_reconcile_required
    || !['ready','published'].includes(item.status)) return false;
  try { if (!captionIsBound(item)) return false; } catch { return false; }
  const text=composeThreads(cleanPublicCopy(item.body,item.source_handle), {
    source:item.source_handle, seed:item.source_url||item.id, artistMentions:item.artist_mentions||[]
  });
  if (!text) {
    item.threads_copy_error='No complete caption fits Threads; Instagram copy is unchanged.';
    return true;
  }
  if (item.threads_container_id && signedCaption(item.threads_text,item) !== text) {
    item.threads_superseded_caption_containers ||= [];
    item.threads_superseded_caption_containers.push(item.threads_container_id);
    for (const suffix of ['container_id','container_created_at','container_checked_at','container_status']) delete item[`threads_${suffix}`];
  }
  item.threads_text=text;
  item.threads_copy_policy='discussion-v2';
  item.discussion_topic=editorialTopic(item.body);
  item.threads_topic_tag=threadsTopicTag(item.body,{artistMentions:item.artist_mentions||[]});
  delete item.threads_copy_error;
  return true;
}

export function refreshCaptionStyle(item, registry=[]) {
  const wrapperPresent=[item.caption,item.threads_text].some(value=>cleanPublicCopy(value,item.source_handle)!==String(value||'').trim());
  const labelPreview=applyVerifiedArtistLabels(item.caption||item.body,registry);
  const publicCaption=cleanPublicCopy(item.caption||item.body,item.source_handle);
  const needsLabels=labelPreview.artist_mentions.length>0 && labelPreview.artist_handles
    .some(handle=>!new RegExp(`@${String(handle).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(publicCaption));
  if((item.caption_style==='source-tag-v1' && !wrapperPresent && !needsLabels) || !['ready','published'].includes(item.status)) return false;
  const pending=prefix=>!item[`${prefix}_media_id`] && !item[`${prefix}_publish_requested_at`] && !item[`${prefix}_reconcile_required`];
  if(!pending('instagram') && !pending('threads')) return false;
  const originalCaption=item.caption;
  const originalThreads=item.threads_text;
  // Preserve the source binding. Never turn unverified source metadata into copy.
  if(item.caption_policy==='vip-source-v1' && !item.instagram_media_id && !item.threads_media_id && captionIsBound(item)) {
    const fields=vipCaption(item.source_caption_text,item.source_handle,item.source_url,registry);
    Object.assign(item,fields,{rendered_body_text:fields.body});
  }
  if (needsLabels) {
    item.artist_handles=labelPreview.artist_handles;
    item.artist_mentions=labelPreview.artist_mentions;
    item.caption=labelPreview.text;
    item.threads_text=labelPreview.text;
    item.threads_topic_tag=threadsTopicTag(labelPreview.text,{artistMentions:labelPreview.artist_mentions});
  }
  item.caption=signedCaption(item.caption,item);
  item.threads_text=signedCaption(item.threads_text||item.caption,item);
  if (!pending('instagram')) item.caption=originalCaption;
  if (!pending('threads')) item.threads_text=originalThreads;
  else {
    const fitted=composeThreads(cleanPublicCopy(item.threads_text,item.source_handle), {
      source:item.source_handle, seed:item.source_url||item.id, artistMentions:item.artist_mentions||[]
    });
    if (fitted) item.threads_text=fitted;
  }
  for(const prefix of ['instagram','threads']) {
    if(!pending(prefix) || !item[`${prefix}_container_id`]) continue;
    // Captions are baked into parent uploads. Keep child uploads and published
    // IDs, but rebuild an unpublished parent with the requested new copy.
    item[`${prefix}_superseded_caption_containers`] ||= [];
    item[`${prefix}_superseded_caption_containers`].push(item[`${prefix}_container_id`]);
    for(const suffix of ['container_id','container_created_at','container_checked_at','container_status']) delete item[`${prefix}_${suffix}`];
  }
  item.caption_style='source-tag-v1';
  return true;
}
