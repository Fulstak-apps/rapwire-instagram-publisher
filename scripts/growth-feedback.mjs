import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {metaClient,errorDelay} from './meta-client.mjs';
import {editorialTopic} from './audience-policy.mjs';

const DAY=86400000;
export function metricValues(payload) {
  return Object.fromEntries((payload.data||[]).map(metric=>{
    const value=metric.total_value?.value ?? metric.values?.at(-1)?.value;
    return [metric.name,typeof value==='number'&&Number.isFinite(value)?value:null];
  }));
}
export function growthSummary(state,now=Date.now()) {
  const samples=Object.values(state.media||{}).filter(x=>Date.parse(x.published_at)>now-14*DAY && x.metrics);
  const groups={};
  for(const sample of samples) {
    const m=sample.metrics,denom=sample.platform==='instagram'?m.reach:m.views;
    const fields=sample.platform==='instagram'?['shares','saved','comments']:['replies','reposts','quotes'];
    if(!(denom>0)||fields.some(key=>typeof m[key]!=='number')) continue;
    const interactions=fields.reduce((sum,key)=>sum+m[key],0);
    for(const [kind,value] of [['source',sample.source],['topic',sample.topic],['question',sample.question]]) {
      if(!value)continue;
      const key=JSON.stringify([sample.platform,kind,value]);
      const group=groups[key] ||= {platform:sample.platform,kind,value,posts:0,exposures:0,interactions:0};
      group.posts++;group.exposures+=denom;group.interactions+=interactions;
    }
  }
  const rates=Object.values(groups).map(x=>({...x,interactions_per_1000:Math.round(x.interactions/x.exposures*10000)/10,
    sufficient_sample:x.posts>=3&&x.exposures>=500}));
  const sourceWeights={};
  for(const platform of ['instagram','threads']) {
    const groups=rates.filter(x=>x.platform===platform&&x.kind==='source'&&x.sufficient_sample);
    const exposures=groups.reduce((sum,x)=>sum+x.exposures,0),count=groups.reduce((sum,x)=>sum+x.interactions,0);
    const baseline=exposures?count/exposures*1000:0;
    if(!baseline)continue;
    for(const group of groups) {
      const ratio=Math.max(.8,Math.min(1.25,group.interactions_per_1000/baseline));
      (sourceWeights[group.value] ||= []).push(ratio);
    }
  }
  const followers={};
  for(const platform of ['instagram','threads']) {
    const history=(state.followers?.[platform]||[]).filter(x=>Number.isFinite(x.count));
    const latest=history.at(-1),prior=history.filter(x=>latest&&Date.parse(x.at)<=Date.parse(latest.at)-20*3600000).at(-1);
    followers[platform]={count:latest?.count??null,checked_at:latest?.at??null,change_since_prior_day:latest&&prior?latest.count-prior.count:null};
  }
  return {generated_at:new Date(now).toISOString(),measured_posts:samples.length,rates:rates.sort((a,b)=>b.interactions_per_1000-a.interactions_per_1000),
    source_weights:Object.fromEntries(Object.entries(sourceWeights).map(([name,values])=>[name,values.reduce((a,b)=>a+b)/values.length])),followers,
    note:'Missing metrics are unavailable, not zero. Follower change is account-wide, not credited to a particular repost. Source weighting starts after 3 measured posts and 500 exposures.'};
}
export function candidateScore(candidate,summary={},now=Date.now()) {
  const fresh=now-Date.parse(summary.generated_at||'')<7*DAY;
  const learned=fresh?summary.source_weights?.[candidate.source.handle]:null;
  const weight=Number.isFinite(learned)?Math.max(.8,Math.min(1.25,learned)):1;
  return Math.log1p(Math.max(0,Number(candidate.viewCount)||0))*weight + 1/(1+Math.max(0,candidate.profilePosition||0));
}
export async function collectGrowth({clients,records,state,save,now=Date.now(),instagramBlocked=false}) {
  state.media ||= {};state.platforms ||= {};state.followers ||= {};
  for(const platform of ['instagram','threads']) {
    const config=clients[platform];
    const lane=state.platforms[platform] ||= {};
    if(!config) {lane.status='credentials_unavailable';continue;}
    if(Date.parse(lane.next_at||'')>now)continue;
    if(platform==='instagram'&&instagramBlocked) {lane.status='waiting_for_instagram_capacity';continue;}
    lane.next_at=new Date(now+6*3600000).toISOString();lane.checked_at=new Date(now).toISOString();await save();
    try {
      const available=records.filter(x=>x[platform+'_media_id']&&Date.parse(x[platform+'_published_at']||x.published_at||'')>now-14*DAY)
        .sort((a,b)=>(Date.parse(state.media[platform+':'+a[platform+'_media_id']]?.checked_at||'')||0)-(Date.parse(state.media[platform+':'+b[platform+'_media_id']]?.checked_at||'')||0)
          || String(b[platform+'_published_at']||b.published_at).localeCompare(String(a[platform+'_published_at']||a.published_at))).slice(0,6);
      for(const item of available) {
        const id=item[platform+'_media_id'];
        const metrics=metricValues(await config.api.get('/'+id+'/insights',{metric:platform==='instagram'?'reach,likes,comments,shares,saved':'views,likes,replies,reposts,quotes'}));
        state.media[platform+':'+id]={platform,id,queue_id:item.id,source:item.source_handle,
          topic:editorialTopic(item.source_caption_text||item.body||''),question:item.threads_copy_policy||'legacy',
          published_at:item[platform+'_published_at']||item.published_at,permalink:item[platform+'_permalink']||null,checked_at:new Date(now).toISOString(),metrics};
        await save();
      }
      const payload=await config.api.get(platform==='instagram'?'/'+config.id:'/'+config.id+'/threads_insights',
        platform==='instagram'?{fields:'followers_count'}:{metric:'followers_count'});
      const count=platform==='instagram'?payload.followers_count:metricValues(payload).followers_count;
      if(typeof count==='number') {
        const history=state.followers[platform] ||= [];
        history.push({at:new Date(now).toISOString(),count});state.followers[platform]=history.slice(-120);
      }
      lane.status='collected';delete lane.error;
    } catch(error) {
      lane.status='unavailable';lane.error=String(error.message).slice(0,600);
      lane.next_at=new Date(now+Math.max(6*3600000,errorDelay(error,now))).toISOString();
    }
    await save();
  }
  state.summary=growthSummary(state,now);await save();return state.summary;
}
export function growthMarkdown(state) {
  const summary=state.summary||growthSummary(state);
  const lines=['## RapWire audience report','',`Measured posts: ${summary.measured_posts}.`, ''];
  for(const platform of ['instagram','threads']) {
    const f=summary.followers[platform];
    lines.push(`${platform}: followers ${f.count??'unavailable'}; daily change ${f.change_since_prior_day??'baseline pending'}; collection ${state.platforms?.[platform]?.status||'pending'}.`);
  }
  lines.push('','| Platform | Category | Source or topic | Posts | Meaningful interactions / 1,000 reach or views |','|---|---|---|---:|---:|');
  for(const x of summary.rates.slice(0,15)) lines.push(`| ${x.platform} | ${x.kind} | ${String(x.value).replace(/[^\w .-]/g,'')} | ${x.posts} | ${x.interactions_per_1000}${x.sufficient_sample?'':' (small sample)'} |`);
  lines.push('',summary.note,'');return lines.join('\n');
}
async function main() {
  const file='logs/growth-feedback.json';
  const state=JSON.parse(await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));
  const save=async()=>{await fs.mkdir('logs',{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(state,null,2)+'\n');await fs.rename(file+'.tmp',file);};
  const records=await Promise.all((await fs.readdir('queue')).filter(x=>x.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile('queue/'+name,'utf8'))));
  const clients={};
  for(const platform of ['instagram','threads']) {
    const token=process.env[platform.toUpperCase()+'_ACCESS_TOKEN'],id=process.env[platform.toUpperCase()+'_USER_ID'];
    if(token&&id)clients[platform]={id,api:metaClient(platform==='threads'?'https://graph.threads.net/v1.0':'https://graph.instagram.com',token)};
  }
  const quota=JSON.parse(await fs.readFile('logs/instagram-publishing-quota.json','utf8').catch(()=> '{}'));
  const cooldown=JSON.parse(await fs.readFile('logs/instagram-cooldown.json','utf8').catch(()=> '{}'));
  await collectGrowth({clients,records,state,save,instagramBlocked:quota.blocked||Date.parse(cooldown.until||'')>Date.now()});
  await fs.writeFile('logs/growth-report.md',growthMarkdown(state));
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,growthMarkdown(state));
  console.log(JSON.stringify({platforms:state.platforms,measured_posts:state.summary.measured_posts}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
