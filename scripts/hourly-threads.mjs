import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {advanceContainer} from './container-state.mjs';
import {errorDelay,metaClient} from './meta-client.mjs';

export const HOUR=60*60_000;
const REPEAT_WINDOW=30*24*HOUR;
export const PROMPTS=[
  'Be honest: what is the most overrated “classic” rap album—and why?',
  'Which rapper has the strongest three-album run? Make the case.',
  'What matters most in a top-five debate: catalog, pen, influence, or longevity?',
  'Who has the best guest-verse catalog in rap? One name and one verse.',
  'Which producer had the best run—and what records prove it?',
  'What album gets better every year you revisit it?',
  'Who is the best live rapper right now? Name the performance that sold you.',
  'What is one rap opinion you changed your mind about?',
  'Which rapper’s catalog deserves a deeper listen than it gets?',
  'All-time great or overrated? Pick one rapper and defend your answer.',
  'What is the best rap album opener ever?',
  'Which city has the strongest rap scene right now—and who is leading it?'
];

export const hourlyText=prompt=>`${prompt}\n\n@rapwire247`;
export function selectPrompt(state,now=Date.now()) {
  const recent=new Set((state.posts||[]).filter(post=>Date.parse(post.published_at||'')>now-REPEAT_WINDOW).map(post=>post.prompt));
  const start=Number(state.next_prompt_index||0)%PROMPTS.length;
  for(let offset=0;offset<PROMPTS.length;offset+=1) {
    const index=(start+offset)%PROMPTS.length;
    if(!recent.has(PROMPTS[index])) return {prompt:PROMPTS[index],index};
  }
  return {prompt:PROMPTS[start],index:start};
}

export async function publishHourlyThread({api,userId,state,save,now=Date.now()}) {
  state.posts ||= [];
  if(Date.parse(state.retry_at||'')>now) return 'cooldown';
  if(!state.verified_at || now-Date.parse(state.verified_at)>24*HOUR) {
    const profile=await api.get('/me',{fields:'id,username'});
    if(String(profile.id)!==String(userId)||String(profile.username).toLowerCase()!=='rapwire247') throw new Error('Hourly Threads account does not match @rapwire247');
    state.verified_at=new Date(now).toISOString(); await save();
  }
  if(!state.pending && (Date.parse(state.last_published_at||'')||0)+HOUR>now) return 'hourly_limit';
  if(!state.pending) {
    const selected=selectPrompt(state,now);
    state.pending={prompt:selected.prompt,text:hourlyText(selected.prompt),prompt_index:selected.index};
    await save();
  }
  const pending=state.pending;
  const result=await advanceContainer({item:pending,prefix:'threads',now,save,
    create:()=>api.post(`/${userId}/threads`,{media_type:'TEXT',text:pending.text}),
    inspect:id=>api.get(`/${id}`,{fields:'status,error_message'}),
    publish:id=>api.post(`/${userId}/threads_publish`,{creation_id:id})
  });
  if(!result) return 'processing';
  const live=await api.get(`/${result.id}`,{fields:'id,permalink,text'});
  if(String(live.id)!==String(result.id)||live.text!==pending.text) throw new Error('Hourly Threads readback did not match the saved post');
  const publishedAt=pending.threads_published_at||new Date(now).toISOString();
  state.posts.push({id:result.id,prompt:pending.prompt,text:pending.text,published_at:publishedAt,permalink:live.permalink||null});
  state.posts=state.posts.filter(post=>Date.parse(post.published_at||'')>now-60*24*HOUR);
  state.last_published_at=publishedAt; state.next_prompt_index=(Number(pending.prompt_index)+1)%PROMPTS.length;
  delete state.pending; delete state.retry_at; delete state.last_error;
  state.status='verified'; state.checked_at=new Date(now).toISOString(); await save();
  return 'verified';
}

const statePath=()=>process.env.RAPWIRE_HOURLY_THREADS_STATE||path.join(os.homedir(),'Library','Application Support','RapWire','hourly-threads-state.json');
async function main() {
  const token=process.env.THREADS_ACCESS_TOKEN,userId=process.env.THREADS_USER_ID;
  if(!token||!userId) {console.log('Hourly Threads: credentials unavailable');return;}
  const file=statePath(); const state=JSON.parse(await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));
  const save=async()=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n');await fs.rename(temp,file);};
  try {console.log(`Hourly Threads: ${await publishHourlyThread({api:metaClient('https://graph.threads.net/v1.0',token),userId,state,save})}`);}
  catch(error) {state.status=state.pending?.threads_reconcile_required?'reconciliation_required':'blocked';state.last_error=String(error.message).replaceAll(token,'[redacted]').slice(0,800);state.last_error_at=new Date().toISOString();state.retry_at=new Date(Date.now()+errorDelay(error)).toISOString();await save();console.log(`Hourly Threads: ${state.status}; ${state.last_error}`);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
