import test from 'node:test';
import assert from 'node:assert/strict';
import {metricValues,growthSummary,candidateScore,collectGrowth,growthMarkdown} from './growth-feedback.mjs';

const NOW=Date.parse('2026-09-03T05:00:00Z'),HOUR=3600000,DAY=24*HOUR;
const iso=value=>new Date(value).toISOString();
const payload=values=>({data:Object.entries(values).map(([name,value])=>({name,values:[{value}]}))});
const metrics=platform=>platform==='instagram'?{reach:200,likes:10,comments:2,shares:3,saved:1}:{views:200,likes:10,replies:2,reposts:3,quotes:1};

function fixture({recordCount=8,state={}}={}) {
  const f={now:NOW,state,calls:[],saved:[],records:Array.from({length:recordCount},(_,i)=>({
    id:'queue'+i,source_handle:'source'+(i%2),body:'A new rap album is being released.',threads_copy_policy:'discussion-v1',
    instagram_media_id:'ig'+i,instagram_published_at:iso(NOW-(i+1)*HOUR),
    threads_media_id:'th'+i,threads_published_at:iso(NOW-(i+1)*HOUR),
  }))};
  f.save=async()=>f.saved.push(structuredClone(f.state));
  f.clients=Object.fromEntries(['instagram','threads'].map(platform=>[platform,{id:platform+'-account',api:{get:async(path,params)=>{
    f.calls.push({platform,path,params});
    assert.equal(f.saved.at(-1).platforms[platform].next_at,iso(f.now+6*HOUR),'persist lane budget before measuring');
    if(path.endsWith('/insights'))return payload(metrics(platform));
    return platform==='instagram'?{followers_count:123}:payload({followers_count:456});
  }}}]));
  f.step=(options={})=>collectGrowth({clients:f.clients,records:f.records,state:f.state,save:f.save,now:f.now,...options});
  f.insights=platform=>f.calls.filter(x=>x.platform===platform&&x.path.endsWith('/insights'));
  return f;
}

test('metric parsing distinguishes a real zero from missing or nonnumeric measurements',()=>{
  assert.deepEqual(metricValues({data:[
    {name:'reach',values:[{value:1},{value:200}]},
    {name:'shares',total_value:{value:0},values:[{value:10}]},
    {name:'saved',values:[]},
    {name:'comments',values:[{value:'2'}]},
    {name:'likes',total_value:{value:Infinity}},
    {name:'replies',total_value:{value:NaN}},
  ]}),{reach:200,shares:0,saved:null,comments:null,likes:null,replies:null});
  assert.deepEqual(metricValues({}),{});
});

test('each platform measures at most six recent posts every six hours and rotates stale samples',async()=>{
  const f=fixture({recordCount:14});
  f.records.push({instagram_media_id:'stale',threads_media_id:'stale',published_at:iso(NOW-15*DAY)});
  await f.step();
  for(const platform of ['instagram','threads'])assert.equal(f.insights(platform).length,6);
  assert.equal(f.state.summary.measured_posts,12);
  assert.equal(f.state.followers.instagram[0].count,123);
  assert.equal(f.state.followers.threads[0].count,456);
  const calls=f.calls.length;
  f.now+=6*HOUR-1;
  await f.step();assert.equal(f.calls.length,calls);
  f.now++;
  await f.step();
  for(const [platform,prefix] of [['instagram','ig'],['threads','th']]) {
    assert.deepEqual(f.insights(platform).slice(6).map(x=>x.path),Array.from({length:6},(_,i)=>'/'+prefix+(i+6)+'/insights'));
    assert.equal(f.insights(platform).length,12);
    assert.equal(f.state.platforms[platform].next_at,iso(NOW+12*HOUR));
  }
});

for(const failed of ['instagram','threads']) {
  test(`${failed} API failure does not stop the other platform or cause an early retry`,async()=>{
    const f=fixture({recordCount:1});
    const healthy=failed==='instagram'?'threads':'instagram';
    let attempts=0;
    f.clients[failed].api.get=async()=>{attempts++;throw Object.assign(new Error('Permission unavailable'),{code:190});};
    await f.step();
    assert.equal(attempts,1);
    assert.equal(f.state.platforms[failed].status,'unavailable');
    assert.equal(f.state.platforms[failed].next_at,iso(NOW+DAY));
    assert.equal(f.state.platforms[healthy].status,'collected');
    assert.equal(f.insights(healthy).length,1);
    f.now+=6*HOUR;
    await f.step();
    assert.equal(attempts,1);
    assert.equal(f.insights(healthy).length,2);
  });
}

test('a partial platform failure retains completed samples while the other platform finishes',async()=>{
  const f=fixture({recordCount:2});
  const get=f.clients.instagram.api.get;
  let attempted=0;
  f.clients.instagram.api.get=async(...args)=>{
    if(++attempted===2)throw new Error('Transient measurement error');
    return get(...args);
  };
  await f.step();
  assert.equal(f.state.platforms.instagram.status,'unavailable');
  assert.ok(f.state.media['instagram:ig0']);
  assert.equal(f.state.media['instagram:ig1'],undefined);
  assert.equal(f.state.platforms.threads.status,'collected');
  assert.equal(f.state.summary.measured_posts,3);
});

test('Instagram capacity holds only its measurement lane and missing credentials remain explicit',async()=>{
  const f=fixture({recordCount:1});
  await f.step({instagramBlocked:true});
  assert.equal(f.insights('instagram').length,0);
  assert.equal(f.state.platforms.instagram.status,'waiting_for_instagram_capacity');
  assert.equal(f.state.platforms.instagram.next_at,undefined);
  assert.equal(f.state.platforms.threads.status,'collected');
  f.clients={};f.now+=6*HOUR;
  await f.step();
  assert.equal(f.state.platforms.instagram.status,'credentials_unavailable');
  assert.equal(f.state.platforms.threads.status,'credentials_unavailable');
});

function sample(source,{platform='instagram',reach=200,interactions=10,published_at=iso(NOW-HOUR),extra={}}={}) {
  return {platform,source,topic:'music',question:'ranking',published_at,
    metrics:platform==='instagram'?{reach,shares:interactions,saved:0,comments:0}:{views:reach,replies:interactions,reposts:0,quotes:0},...extra};
}

test('rates require every meaningful metric and never turn missing measurements into zero',()=>{
  const complete=sample('complete');
  const missing=sample('missing');delete missing.metrics.saved;
  const nullMetric=sample('null');nullMetric.metrics.comments=null;
  const noReach=sample('zero',{reach:0});
  const stale=sample('stale',{published_at:iso(NOW-15*DAY)});
  const summary=growthSummary({media:{complete,missing,nullMetric,noReach,stale}},NOW);
  assert.equal(summary.measured_posts,4);
  assert.deepEqual(summary.rates.filter(x=>x.kind==='source').map(x=>x.value),['complete']);
  assert.deepEqual(summary.source_weights,{});
  assert.match(summary.note,/unavailable, not zero/);
});

test('source weighting requires both three posts and 500 exposures per platform and stays bounded',()=>{
  const media={};
  for(let i=0;i<3;i++) {
    media['strong'+i]=sample('strong',{interactions:100});
    media['weak'+i]=sample('weak',{interactions:0});
    media['low-reach'+i]=sample('low-reach',{reach:100,interactions:90});
  }
  for(let i=0;i<2;i++)media['few-posts'+i]=sample('few-posts',{reach:1000,interactions:900});
  media['cross-ig0']=sample('cross-platform');media['cross-ig1']=sample('cross-platform');
  media['cross-th0']=sample('cross-platform',{platform:'threads'});
  const summary=growthSummary({media},NOW);
  assert.deepEqual(summary.source_weights,{strong:1.25,weak:.8});
  assert.equal(summary.rates.find(x=>x.kind==='source'&&x.value==='low-reach').sufficient_sample,false);
  assert.ok(summary.rates.filter(x=>x.kind==='source'&&x.value==='cross-platform').every(x=>!x.sufficient_sample));
  const exact={};
  for(const [i,reach] of [100,200,200].entries())exact[i]=sample('boundary',{reach});
  assert.equal(growthSummary({media:exact},NOW).source_weights.boundary,1);
});

test('candidate scoring uses only fresh learned weights and clamps feedback influence',()=>{
  const candidate={source:{handle:'source'},viewCount:100,profilePosition:0};
  const base=Math.log1p(100);
  assert.equal(candidateScore(candidate,{},NOW),base+1);
  assert.equal(candidateScore(candidate,{generated_at:iso(NOW),source_weights:{source:50}},NOW),base*1.25+1);
  assert.equal(candidateScore(candidate,{generated_at:iso(NOW),source_weights:{source:-50}},NOW),base*.8+1);
  assert.equal(candidateScore(candidate,{generated_at:iso(NOW-8*DAY),source_weights:{source:1.25}},NOW),base+1);
});

test('followers use account-wide daily history and missing follower metrics are unavailable',async()=>{
  const f=fixture({recordCount:0,state:{followers:{instagram:[{at:iso(NOW-DAY),count:120}],threads:[]}}});
  f.clients.threads.api.get=async()=>({data:[]});
  await f.step();
  assert.equal(f.state.summary.followers.instagram.change_since_prior_day,3);
  assert.equal(f.state.summary.followers.threads.count,null);
  assert.equal(f.state.summary.followers.threads.change_since_prior_day,null);
  const markdown=growthMarkdown(f.state);
  assert.match(markdown,/threads: followers unavailable; daily change baseline pending/);
  assert.match(markdown,/account-wide, not credited to a particular repost/);
});

test('follower history stays bounded and an HTTP retry-after extends the lane cooldown',async()=>{
  const history=Array.from({length:120},(_,i)=>({at:iso(NOW-(120-i)*6*HOUR),count:i}));
  const f=fixture({recordCount:0,state:{followers:{instagram:history}}});
  f.clients.threads.api.get=async()=>{throw Object.assign(new Error('Try later'),{retryAfter:'90000'});};
  await f.step();
  assert.equal(f.state.followers.instagram.length,120);
  assert.equal(f.state.followers.instagram.at(-1).count,123);
  assert.equal(f.state.platforms.threads.next_at,iso(NOW+90000*1000));
});
