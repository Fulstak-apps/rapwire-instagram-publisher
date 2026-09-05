import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {advanceContainer} from './container-state.mjs';
import {errorDelay,metaClient} from './meta-client.mjs';
import {threadsTopicTag} from './audience-policy.mjs';

export const HOUR=60*60_000;
export const CONVERSATION_INTERVAL=15*60_000;
const REPEAT_WINDOW=30*24*HOUR;
export const PROMPTS=[
  'Be real: what “classic” rap album gets overrated the most—and why?',
  'Who got the strongest three-album run in rap? Make your case.',
  'When y’all talk top 5, what matters most: catalog, pen, influence, or longevity?',
  'Who got the best guest-verse catalog in rap? Name one verse too.',
  'Which producer really had the best run—and what records prove it?',
  'What rap album gets better every time you run it back?',
  'Who is the best live rapper right now? What performance sold you?',
  'What rap opinion did y’all actually change your mind about?',
  'Which rapper’s catalog deserves way more respect?',
  'All-time great or overrated? Pick one rapper and stand on it.',
  'What is the best rap album opener ever? Don’t say it without a reason.',
  'Which city got the strongest rap scene right now—and who is really leading it?'
  ,'What rapper had one huge year that people still underrate? Bring receipts.'
  ,'What rap song had the hardest first 20 seconds ever?'
  ,'Who is one rapper everybody calls a legend but you never connected with?'
  ,'What rapper could drop tonight and take over the whole weekend?'
  ,'Which rap duo would make the best full album right now?'
  ,'Who has the best beat selection in rap history?'
  ,'What rap song aged way better than people expected?'
  ,'Who won a rap beef that people still refuse to admit they lost?'
  ,'Name a rapper with no bad albums. Is there really one?'
  ,'What rapper has the most loyal fanbase—and is that helping or hurting the music?'
  ,'What album changed the sound of rap the most in the last ten years?'
  ,'Who is the better feature artist than solo artist?'
  ,'What rapper deserves a comeback run right now?'
  ,'Which rapper has the hardest unreleased catalog?'
  ,'What is one rap hit you never need to hear again?'
  ,'Who has the most recognizable voice in rap history?'
  ,'What rapper gets judged more for personality than music?'
  ,'Which rapper had the biggest wasted potential?'
  ,'What is the greatest diss record ever—and what makes it number one?'
  ,'Who is carrying their city right now?'
  ,'What rapper has the strongest opening track catalog?'
  ,'Whose old music is better than their new music? Be honest.'
  ,'What current rapper would have survived every era of hip-hop?'
  ,'Who is the best storyteller rap has ever produced?'
  ,'What rapper deserves a Verzuz but has no obvious opponent?'
  ,'What rap take gets you kicked out of the group chat every time?'
  ,'Which rapper made the biggest leap between two albums?'
  ,'What classic rap song would be even bigger if it dropped today?'
  ,'Who has the best ad-libs in rap?'
  ,'What rapper do critics understand completely wrong?'
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
    if(String(profile.id)!==String(userId)) throw new Error('Threads account ID does not match the configured @rapwire247 account');
    state.verified_at=new Date(now).toISOString(); await save();
  }
  if(!state.pending && (Date.parse(state.last_published_at||'')||0)+CONVERSATION_INTERVAL>now) return 'interval_limit';
  if(!state.pending) {
    const selected=selectPrompt(state,now);
    state.pending={prompt:selected.prompt,text:hourlyText(selected.prompt),topic_tag:threadsTopicTag(selected.prompt),prompt_index:selected.index};
    await save();
  }
  const pending=state.pending;
  const result=await advanceContainer({item:pending,prefix:'threads',now,save,
    create:()=>api.post(`/${userId}/threads`,{media_type:'TEXT',text:pending.text,topic_tag:pending.topic_tag}),
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
