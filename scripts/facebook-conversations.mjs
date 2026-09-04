import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {metaClient,errorDelay} from './meta-client.mjs';
import {hourlyText,selectPrompt} from './hourly-threads.mjs';

export const FACEBOOK_CONVERSATION_INTERVAL=60*60_000;

export async function publishFacebookConversation({api,pageId,state,save,now=Date.now()}) {
  state.posts ||= [];
  if (Date.parse(state.retry_at||'')>now) return 'cooldown';
  if (!state.pending && (Date.parse(state.last_published_at||'')||0)+FACEBOOK_CONVERSATION_INTERVAL>now) return 'interval_limit';
  if (!state.pending) {
    const selected=selectPrompt(state,now);
    state.pending={prompt:selected.prompt,text:hourlyText(selected.prompt),prompt_index:selected.index};
    await save();
  }
  const pending=state.pending;
  // A Page feed post is non-idempotent. Persist intent before sending and never
  // blindly retry an unknown response, which protects followers from duplicates.
  if (pending.publish_requested_at) return 'reconciliation_required';
  pending.publish_requested_at=new Date(now).toISOString();
  await save();
  const published=await api.post(`/${pageId}/feed`,{message:pending.text});
  const id=published.post_id||published.id;
  if (!id) throw new Error('Facebook conversation publish response did not include an ID');
  const live=await api.get(`/${id}`,{fields:'id,permalink_url,message'});
  if (String(live.id)!==String(id) || live.message!==pending.text) throw new Error('Facebook conversation readback did not match the saved post');
  const publishedAt=new Date(now).toISOString();
  state.posts.push({id:String(id),prompt:pending.prompt,text:pending.text,published_at:publishedAt,permalink:live.permalink_url||null});
  state.posts=state.posts.filter(post=>Date.parse(post.published_at||'')>now-60*24*60*60_000);
  state.last_published_at=publishedAt;
  state.next_prompt_index=(Number(pending.prompt_index)+1)%1000;
  delete state.pending; delete state.retry_at; delete state.last_error;
  state.status='verified'; state.checked_at=publishedAt;
  await save();
  return 'verified';
}

async function resolvePageApi(token,pageId) {
  const configured=metaClient('https://graph.facebook.com',token);
  try {
    const page=await configured.get(`/${pageId}`,{fields:'id,access_token'});
    return page.access_token?metaClient('https://graph.facebook.com',page.access_token):configured;
  } catch { return configured; }
}

async function main() {
  const token=process.env.FACEBOOK_PAGE_ACCESS_TOKEN,pageId=process.env.FACEBOOK_PAGE_ID;
  if(!token||!pageId) {console.log('Facebook conversations: credentials unavailable');return;}
  const statePath=process.env.RAPWIRE_FACEBOOK_CONVERSATIONS_STATE||'logs/facebook-conversations.json';
  const state=JSON.parse(await fs.readFile(statePath,'utf8').catch(error=>error.code==='ENOENT'?'{}':Promise.reject(error)));
  const save=async()=>{await fs.mkdir(path.dirname(statePath),{recursive:true});await fs.writeFile(`${statePath}.tmp`,JSON.stringify(state,null,2)+'\n');await fs.rename(`${statePath}.tmp`,statePath);};
  try { console.log(`Facebook conversations: ${await publishFacebookConversation({api:await resolvePageApi(token,pageId),pageId,state,save})}`); }
  catch(error) {
    state.status=state.pending?.publish_requested_at?'reconciliation_required':'blocked';
    state.last_error=String(error.message).replaceAll(token,'[redacted]').slice(0,800);
    state.last_error_at=new Date().toISOString(); state.retry_at=new Date(Date.now()+errorDelay(error)).toISOString();
    await save(); console.log(`Facebook conversations: ${state.status}; ${state.last_error}`);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
