import {errorDelay} from './meta-client.mjs';

const iso=milliseconds=>new Date(milliseconds).toISOString();

export function facebookMedia(item,{mediaUrl,slideUrl,videoUrl}) {
  if (Array.isArray(item.media_items) && item.media_items.length) {
    return item.media_items.map(media=>({type:media.type,url:mediaUrl(media.path)}));
  }
  if (item.content_type==='video') return [{type:'video',url:videoUrl(item)}];
  return (item.slides||[]).map((_,index)=>({type:'image',url:slideUrl(item,index)}));
}

export async function deliverFacebookPage({item,api,pageId,caption,media,save,now=Date.now}) {
  if (item.facebook_media_id) {
    if (!item.facebook_verified_at) {
      const live=await api.get(`/${item.facebook_media_id}`,{fields:'id,permalink_url'});
      if (String(live.id)!==String(item.facebook_media_id)) throw new Error('Facebook verification returned a different media ID');
      item.facebook_verified_at=iso(now());
      if(live.permalink_url)item.facebook_permalink=live.permalink_url;
      await save();
    }
    return {status:'verified',id:item.facebook_media_id,permalink:item.facebook_permalink};
  }
  if (item.facebook_reconcile_required || item.facebook_publish_requested_at) {
    item.facebook_reconcile_required=true;
    item.facebook_status='reconciliation_required';
    await save();
    return {status:'reconciliation_required'};
  }
  if (!media.length) return {status:'review_required',reason:'facebook_media_missing'};
  const types=new Set(media.map(entry=>entry.type));
  if (types.size>1 || types.has('video')&&media.length>1) {
    item.facebook_status='review_required';
    item.facebook_review_reason='Facebook mirror supports one video or an image carousel; mixed/multi-video posts are held intact.';
    await save();
    return {status:'review_required',reason:'unsupported_facebook_media_mix'};
  }
  try {
    let published;
    if (types.has('video')) {
      item.facebook_publish_requested_at=iso(now());
      await save();
      published=await api.post(`/${pageId}/videos`,{file_url:media[0].url,description:caption});
    } else if (media.length===1) {
      item.facebook_publish_requested_at=iso(now());
      await save();
      published=await api.post(`/${pageId}/photos`,{url:media[0].url,caption});
    } else {
      item.facebook_children ||= [];
      item.facebook_child_requests ||= [];
      for(let index=0;index<media.length;index+=1) {
        if(item.facebook_children[index])continue;
        if(item.facebook_child_requests[index]) {
          item.facebook_reconcile_required=true;
          item.facebook_status='reconciliation_required';
          await save();
          return {status:'reconciliation_required'};
        }
        item.facebook_child_requests[index]=iso(now());
        await save();
        const child=await api.post(`/${pageId}/photos`,{url:media[index].url,published:'false'});
        item.facebook_children[index]=child.id;
        await save();
      }
      item.facebook_publish_requested_at=iso(now());
      await save();
      published=await api.post(`/${pageId}/feed`,{
        message:caption,
        attached_media:JSON.stringify(item.facebook_children.map(id=>({media_fbid:id})))
      });
    }
    const id=published.post_id||published.id;
    if(!id)throw Object.assign(new Error('Facebook publish response did not include an ID'),{definitiveRejection:false});
    item.facebook_media_id=String(id);
    item.facebook_status='published';
    item.facebook_published_at=iso(now());
    delete item.facebook_error;
    delete item.facebook_retry_at;
    await save();
    const live=await api.get(`/${item.facebook_media_id}`,{fields:'id,permalink_url'});
    if(String(live.id)!==String(item.facebook_media_id))throw new Error('Facebook verification returned a different media ID');
    item.facebook_verified_at=iso(now());
    if(live.permalink_url)item.facebook_permalink=live.permalink_url;
    await save();
    return {status:'published',id:item.facebook_media_id,permalink:item.facebook_permalink};
  } catch(error) {
    item.facebook_error=error.message;
    if(error.definitiveRejection) {
      delete item.facebook_publish_requested_at;
      item.facebook_status='failed';
      item.facebook_retry_at=iso(now()+errorDelay(error,now()));
    } else {
      item.facebook_status='reconciliation_required';
      item.facebook_reconcile_required=true;
    }
    await save();
    throw error;
  }
}
