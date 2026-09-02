import {captionIsBound} from './video-caption.mjs';

export const isMediaRepost = item => item.type === 'source_media_repost';
export function validMediaRepost(item) {
  return isMediaRepost(item) && item.vip_repost === true && captionIsBound(item)
    && item.layout_template === 'rapwire-source-media-v1'
    && item.visual_asset_rights === 'source_post_repost'
    && item.media_capture_complete === true
    && Array.isArray(item.media_items) && item.media_items.length>=1 && item.media_items.length<=10
    && item.source_item_count === item.media_items.length
    && item.media_items.every((m,i)=>m.source_index===i && typeof m.path==='string'
      && (m.type==='image'?m.path.endsWith('.jpg'):m.type==='video' && m.path.endsWith('.mp4')))
    && new Set(item.media_items.map(m=>m.path)).size===item.media_items.length
    && item.content_type === (item.media_items.length===1?'image':'carousel');
}
export function mediaFiles(item) {
  return [...new Set([item.video,item.story,item.story_video,...(item.media_items||[]).map(m=>m.path)].filter(Boolean))];
}
