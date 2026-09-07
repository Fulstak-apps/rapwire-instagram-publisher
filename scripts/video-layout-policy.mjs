import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';

const sha256=/^[a-f0-9]{64}$/i;
const positiveInteger=value=>Number.isInteger(value)&&value>0;

export function validVideoLayout(layout) {
  const crop=layout?.crop;
  return Boolean(layout?.version==='footage-only-v1' && layout.status==='validated'
    && positiveInteger(layout.source_width) && positiveInteger(layout.source_height)
    && crop && Number.isInteger(crop.x) && crop.x>=0 && Number.isInteger(crop.y) && crop.y>=0
    && positiveInteger(crop.width) && positiveInteger(crop.height)
    && [crop.x,crop.y,crop.width,crop.height].every(value=>value%2===0)
    && crop.x+crop.width<=layout.source_width && crop.y+crop.height<=layout.source_height
    && layout.output_width===1080 && layout.output_height===1350
    && layout.caption_overlay===false && layout.logo_position==='bottom-left'
    && sha256.test(layout.source_sha256||'') && sha256.test(layout.output_sha256||''));
}

export function videoAssets(item) {
  if(item.content_type==='video') return [{path:item.video,video_layout:item.video_layout,label:'video'}];
  return (item.media_items||[]).flatMap((media,index)=>media.type==='video'
    ? [{...media,label:`media_items[${index}]`}]:[]);
}

export function videoLayoutGate(item) {
  const issues=[];
  for(const asset of videoAssets(item)) {
    if(typeof asset.path!=='string'||!asset.path.endsWith('.mp4'))issues.push(`${asset.label}: missing local MP4 render`);
    if(!validVideoLayout(asset.video_layout))issues.push(`${asset.label}: recapture or review required; validated footage-only crop and source/output hashes are missing or invalid`);
  }
  if(item.content_type==='video'&&item.video_url)issues.push('video: remote video_url override is not bound to the validated local render; remove it after verifying the rendered asset');
  return {allowed:issues.length===0,issues};
}

export async function verifyVideoLayoutFiles(item,root=process.cwd()) {
  const result=videoLayoutGate(item);
  if(!result.allowed)return result;
  for(const asset of videoAssets(item)) {
    const filename=path.resolve(root,asset.path);
    const relative=path.relative(path.resolve(root),filename);
    if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) {
      result.issues.push(`${asset.label}: rendered asset must remain inside the queue repository`);
      continue;
    }
    try {
      const hash=createHash('sha256');
      for await(const bytes of createReadStream(filename))hash.update(bytes);
      if(hash.digest('hex')!==asset.video_layout.output_sha256.toLowerCase())result.issues.push(`${asset.label}: rendered bytes no longer match the validated output hash; review or recapture required`);
    } catch {
      result.issues.push(`${asset.label}: validated rendered file is unavailable; restore the exact asset or recapture`);
    }
  }
  result.allowed=result.issues.length===0;
  return result;
}

export function mediaRepairAllowed(item) {
  if(item.status!=='ready')return false;
  return ['instagram','threads','instagram_story'].every(prefix=>!item[`${prefix}_media_id`]
    && !item[`${prefix}_container_id`] && !item[`${prefix}_children`]?.some(Boolean)
    && !item[`${prefix}_publish_requested_at`] && !item[`${prefix}_reconcile_required`]
    && item[`${prefix}_status`]!=='published');
}

export const videoRepairAllowed=item=>item.content_type==='video'&&mediaRepairAllowed(item);

export function mixedVideoLayoutReview(item,result=videoLayoutGate(item)) {
  if(item.type!=='source_media_repost'||!mediaRepairAllowed(item)||result.allowed)return null;
  const indices=(item.media_items||[]).flatMap((media,index)=>media.type==='video'?[index]:[]);
  if(!indices.length)return null;
  return {status:'review_required',source_url:item.source_url,video_indices:indices,
    reason:'Recapture the complete source carousel and verify every image/video against the saved order before replacing these video assets with validated footage-only renders. Existing entries lack source-image identity proof, so automatic substitution could change the post.',
    issues:result.issues};
}

export function capturedVideoLayout(evidence) {
  if(!validVideoLayout(evidence?.video_layout))throw new Error('Capture lacks validated footage-only video layout; retain the queue item for review');
  return structuredClone(evidence.video_layout);
}

export function capturedMediaItems(evidence,destinations) {
  return evidence.items.map((media,index)=>({type:media.type,path:destinations[index],source_index:index,
    ...(media.type==='video'?{video_layout:capturedVideoLayout(media)}:{})}));
}
