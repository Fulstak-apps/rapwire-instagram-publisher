import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {metaClient,errorDelay} from './meta-client.mjs';
import {advanceContainer} from './container-state.mjs';

const ACCOUNT='RapWikip';
const INTERVAL=30*60_000;
export function ingest(state, response, initial=false) {
  if (response.errors?.length) throw new Error('Incomplete X response; cursor not advanced');
  state.items ||= {};
  const media=new Map((response.includes?.media||[]).map(m=>[m.media_key,m]));
  const posts=[...(response.data||[])].sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);
  for (const post of (initial?posts.slice(0,10):posts)) {
    if (state.items[post.id]) continue;
    const assets=(post.attachments?.media_keys||[]).map(key=>media.get(key));
    const item={id:post.id,source_url:`https://x.com/${ACCOUNT}/status/${post.id}`,source_created_at:post.created_at,
      text:post.note_tweet?.text||post.text||'',assets, status:'queued'};
    if (assets.some(m=>!m) || post.attachments?.poll_ids?.length || post.referenced_tweets?.length) {
      item.status='review'; item.error='Referenced post, poll, or missing attachment requires full context';
    }
    state.items[post.id]=item;
  }
  return posts[0]?.id;
}

export function payload(item) {
  let text=item.text.trim();
  // Preserve dated anniversary context when a backfill is no longer today.
  if (/\btoday\b/i.test(text) && item.source_created_at?.slice(0,10)!==new Date().toISOString().slice(0,10)) {
    text=`From ${item.source_created_at.slice(0,10)}:\n${text}`;
  }
  text=`${text}\n\n@rapwire247`;
  if (!item.text.trim() || [...text].length>500) throw new Error('Caption empty or exceeds 500 characters; needs review, never truncated');
  const assets=item.assets.map(m=>{
    if (m.type==='photo' && /^https:\/\/pbs\.twimg\.com\//.test(m.url||'')) return {media_type:'IMAGE',image_url:m.url};
    const variant=(m.variants||[]).filter(v=>v.content_type==='video/mp4' && /^https:\/\/video\.twimg\.com\//.test(v.url||''))
      .sort((a,b)=>(b.bit_rate||0)-(a.bit_rate||0))[0];
    if (variant) return {media_type:'VIDEO',video_url:variant.url};
    throw new Error('Original playable media unavailable; never substitute a thumbnail');
  });
  if (assets.length>20) throw new Error('Too many carousel items');
  return {text,assets};
}

export async function collect(state, get, save, now=Date.now()) {
  if (now-(Date.parse(state.last_collected_at||'')||0)<15*60_000) return;
  if (!state.user_id) {
    const profile=await get(`/users/by/username/${ACCOUNT}`);
    if (profile.data?.username?.toLowerCase()!==ACCOUNT.toLowerCase()) throw new Error('X source identity mismatch');
    state.user_id=profile.data.id;
  }
  const initial=!state.initialized;
  let token=state.pagination_token;
  const response=await get(`/users/${state.user_id}/tweets`,{
    max_results:initial?'10':'100',exclude:'retweets,replies',
    'tweet.fields':'created_at,attachments,note_tweet,referenced_tweets',
    expansions:'attachments.media_keys','media.fields':'type,url,variants,duration_ms',
    ...(state.since_id?{since_id:state.since_id}:{}),...(token?{pagination_token:token}:{})});
  const newest=ingest(state,response,initial);
  if (newest && (!state.scan_newest || BigInt(newest)>BigInt(state.scan_newest))) state.scan_newest=newest;
  state.pagination_token=initial?null:response.meta?.next_token||null;
  if (!state.pagination_token) {
    state.since_id=state.scan_newest||state.since_id;
    delete state.scan_newest;state.initialized=true;
    state.last_collected_at=new Date(now).toISOString();
  }
  await save();
}

export async function publishOne(state,api,save,now=Date.now()) {
  const profile=await api.get('/me',{fields:'id,username'});
  if (profile.username?.toLowerCase()!=='rapwire247') throw new Error('Threads destination identity mismatch');
  if (now-(Date.parse(state.last_published_at||'')||0)<INTERVAL) return 'paced';
  const quota=(await api.get(`/${profile.id}/threads_publishing_limit`,{fields:'quota_usage,config'})).data?.[0];
  if (!Number.isFinite(quota?.quota_usage) || !Number.isFinite(quota?.config?.quota_total)) throw new Error('Cannot verify Threads quota');
  // Leave 20% capacity for the main video feed and other approved activity.
  if (quota.quota_usage>=Math.floor(quota.config.quota_total*.8)) return 'quota_hold';
  for (const item of Object.values(state.items||{}).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1)) {
    if (item.status!=='queued' || item.threads_reconcile_required || Date.parse(item.retry_at||'')>now) continue;
    try {
      const {text,assets}=payload(item);
      const create=async()=>{
        if (assets.length<=1) return api.post(`/${profile.id}/threads`,{...(assets[0]||{media_type:'TEXT'}),text});
        item.children ||= [];
        for (let i=item.children.length;i<assets.length;i++) {
          const child=await api.post(`/${profile.id}/threads`,{...assets[i],is_carousel_item:'true'});
          if (!child.id) throw new Error('Child container ID missing');
          item.children.push(child.id);await save();
        }
        for (const id of item.children) {
          const status=await api.get(`/${id}`,{fields:'status,error_message'});
          if (status.status!=='FINISHED') throw new Error(`Carousel child ${status.status}; retry later`);
        }
        return api.post(`/${profile.id}/threads`,{media_type:'CAROUSEL',children:item.children.join(','),text});
      };
      const result=await advanceContainer({item,prefix:'threads',now,save,create,
        inspect:id=>api.get(`/${id}`,{fields:'status,error_message'}),
        publish:id=>api.post(`/${profile.id}/threads_publish`,{creation_id:id})});
      if (result) {
        item.status='published';state.last_published_at=item.threads_published_at;await save();
        const live=await api.get(`/${result.id}`,{fields:'id,permalink'});
        item.permalink=live.permalink;await save();
        return 'published';
      }
      return 'processing';
    } catch(error) {
      item.error=error.message;
      if (/needs review|unavailable; never|Too many/.test(error.message)) item.status='review';
      item.retry_at=new Date(now+errorDelay(error)).toISOString();await save();
      // Uncertain publication must not be blindly repeated on the next run.
      if (item.threads_publish_requested_at && !item.threads_media_id) {item.threads_reconcile_required=true;await save();}
    }
  }
  return 'no_eligible_items';
}

async function main() {
  if (process.env.RAPWIRE_X_MIRROR_ENABLED!=='true') {console.log('X mirror disabled; existing publishers unchanged.');return;}
  const token=process.env.X_BEARER_TOKEN;
  if (!token || !process.env.THREADS_ACCESS_TOKEN) throw new Error('X_BEARER_TOKEN and THREADS_ACCESS_TOKEN required');
  const file='logs/x-rapwikip-state.json';
  const state=JSON.parse(await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '{}';throw e;}));
  const save=async()=>{await fs.mkdir('logs',{recursive:true});await fs.writeFile(`${file}.tmp`,JSON.stringify(state,null,2)+'\n');await fs.rename(`${file}.tmp`,file);};
  const get=async(endpoint,params={})=>{
    const url=new URL(`https://api.x.com/2${endpoint}`);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`X collection HTTP ${response.status}`);
    return response.json();
  };
  try {await collect(state,get,save);} catch(e) {state.collection_error=e.message;await save();console.error(e.message);}
  console.log(await publishOne(state,metaClient('https://graph.threads.net/v1.0',process.env.THREADS_ACCESS_TOKEN),save));
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
