import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {advanceContainer} from './container-state.mjs';
import {selectReply} from './audience-policy.mjs';
import {metaClient,errorDelay} from './meta-client.mjs';

const GAP=30*60000, DAY=86400000;
export async function engage({api,userId,records,state,save,now=Date.now()}) {
  state.replied_ids ||= {};
  state.started_at ||= new Date(now).toISOString();
  const events=Object.values(state.replied_ids).filter(x=>!x.skipped&&Date.parse(x.at||'')>now-DAY);
  const finish=async(status,details={})=>{
    state.status=status;state.checked_at=new Date(now).toISOString();Object.assign(state,details);await save();return status;
  };
  if(Date.parse(state.retry_at||'')>now) return 'cooldown';
  if(!state.pending && ((Date.parse(state.last_reply_at||'')||0)+GAP>now || events.length>=12)) return finish('daily_or_interval_limit');
  if(!state.pending && now-(Date.parse(state.last_scan_at||'')||0)<15*60000) return 'scan_cooldown';
  if(!state.verified_at || now-Date.parse(state.verified_at)>DAY) {
    const profile=await api.get('/me',{fields:'id,username'});
    if(String(profile.id)!==String(userId)||String(profile.username).toLowerCase()!=='rapwire247') throw new Error('Reply account does not match @rapwire247');
    state.verified_at=new Date(now).toISOString();
  }
  if(!state.pending) {
    const parents=records.filter(x=>x.threads_media_id && Date.parse(x.threads_published_at||x.published_at||'')>now-7*DAY)
      .sort((a,b)=>String(b.threads_published_at||b.published_at).localeCompare(String(a.threads_published_at||a.published_at)));
    const start=Number(state.scan_cursor||0)%Math.max(1,parents.length);
    const window=[...parents.slice(start),...parents.slice(0,start)].slice(0,3);
    state.scan_cursor=(start+window.length)%Math.max(1,parents.length);
    state.last_scan_at=new Date(now).toISOString();await save();
    for(const parent of window) {
      const replies=await api.get('/'+parent.threads_media_id+'/replies',{fields:'id,text,timestamp,username,is_reply_owned_by_me',reverse:'true',limit:'25'});
      for(const comment of replies.data||[]) {
        if(!comment.id || !comment.username || comment.is_reply_owned_by_me
          || comment.username.toLowerCase()==='rapwire247' || state.replied_ids[comment.id]
          || !(Date.parse(comment.timestamp)>=Date.parse(state.started_at))) continue;
        const participant=comment.username.toLowerCase();
        if(events.filter(x=>x.username===participant).length>=2 || events.some(x=>x.source_post_id===parent.threads_media_id&&x.username===participant)) continue;
        const reply=selectReply(parent.body||parent.threads_text,comment.text,comment.id);
        if(!reply || events.some(x=>x.text===reply.text)) continue;
        state.pending={target_id:comment.id,source_post_id:parent.threads_media_id,username:participant,text:reply.text,mode:reply.mode};
        await save();break;
      }
      if(state.pending) break;
    }
  }
  if(!state.pending) return finish('no_eligible_replies');
  const pending=state.pending;
  const result=await advanceContainer({item:pending,prefix:'threads',now,save,
    create:()=>api.post('/'+userId+'/threads',{media_type:'TEXT',text:pending.text,reply_to_id:pending.target_id}),
    inspect:id=>api.get('/'+id,{fields:'status,error_message'}),
    publish:id=>api.post('/'+userId+'/threads_publish',{creation_id:id})});
  if(!result) return finish('processing');
  const live=await api.get('/'+result.id,{fields:'id,permalink,text,replied_to'});
  if(String(live.id)!==String(result.id) || live.text!==pending.text || String(live.replied_to?.id)!==String(pending.target_id)) throw new Error('Reply readback did not match the saved target and text');
  state.replied_ids[pending.target_id]={at:pending.threads_published_at,reply_id:result.id,
    source_post_id:pending.source_post_id,username:pending.username,text:pending.text,mode:pending.mode,permalink:live.permalink||null};
  state.last_reply_at=pending.threads_published_at;
  delete state.pending;delete state.last_error;delete state.retry_at;
  return finish('verified');
}

async function main() {
  const token=process.env.THREADS_ACCESS_TOKEN,userId=process.env.THREADS_USER_ID;
  if(!token||!userId) {console.log('Threads replies: credentials unavailable');return;}
  const statePath='logs/threads-replies.json';
  const state=JSON.parse(await fs.readFile(statePath,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));
  const save=async()=>{await fs.mkdir('logs',{recursive:true});await fs.writeFile(statePath+'.tmp',JSON.stringify(state,null,2)+'\n');await fs.rename(statePath+'.tmp',statePath);};
  const records=await Promise.all((await fs.readdir('queue')).filter(x=>x.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile('queue/'+name,'utf8'))));
  try {
    const status=await engage({api:metaClient('https://graph.threads.net/v1.0',token),userId,records,state,save});
    console.log('Threads replies: '+status);
  } catch(error) {
    state.status=state.pending?.threads_reconcile_required?'reconciliation_required':'blocked';
    state.last_error=String(error.message).replaceAll(token,'[redacted]').slice(0,800);
    state.last_error_at=new Date().toISOString();state.retry_at=new Date(Date.now()+errorDelay(error)).toISOString();
    await save();console.log('Threads replies: '+state.status+'; '+state.last_error);
  }
  if(process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    '\nThreads replies: **'+(state.status||'waiting')+'**. '+(state.last_error?'See logs/threads-replies.json for the blocker.':'')+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
