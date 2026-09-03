import {captionIsBound} from './video-caption.mjs';
import {vipCaption} from './vip-policy.mjs';

export function signedCaption(value,item={}) {
  const tag='';
  let text=String(value||'').trim()
    .replace(/(?:\n\n)?Rap\s*Wire 24\/7\.?\s*\n@Rapwire247(?:\s*\n@[A-Za-z0-9_.]+)?\s*$/i,'')
    .replace(/(?:\n\n)?Rap\s*Wire 24\/7\.?\s*$/i,'')
    .replace(/(?:\n\n)?@Rapwire247\s*$/i,'')
    .replace(/^Reposted from @[A-Za-z0-9_.]+\.\s*/i,'').trim();
  // Strip an existing standalone source credit before placing it at the top.
  text=text.split('\n').filter(line=>!/^@[A-Za-z0-9_.]+$/.test(line.trim())).join('\n').trim();
  return [tag,text,'@rapwire247'].filter(Boolean).join('\n\n');
}

export function refreshCaptionStyle(item) {
  if(item.caption_style==='source-tag-v1' || !['ready','published'].includes(item.status)) return false;
  const pending=prefix=>!item[`${prefix}_media_id`] && !item[`${prefix}_publish_requested_at`] && !item[`${prefix}_reconcile_required`];
  if(!pending('instagram') && !pending('threads')) return false;
  // Preserve the source binding. Never turn unverified source metadata into copy.
  if(item.caption_policy==='vip-source-v1' && captionIsBound(item)) {
    const fields=vipCaption(item.source_caption_text,item.source_handle,item.source_url);
    Object.assign(item,fields,{rendered_body_text:fields.body});
  }
  item.caption=signedCaption(item.caption,item);
  item.threads_text=signedCaption(item.threads_text||item.caption,item);
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
