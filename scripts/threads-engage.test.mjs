import test from 'node:test';
import assert from 'node:assert/strict';
import {engage} from './threads-engage.mjs';

const NOW=Date.parse('2026-09-03T05:00:00Z');
const iso=value=>new Date(value).toISOString();
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture({state={},records,comments}={}) {
  const f={now:NOW,state,comments:comments||[
    {id:'comment',username:'listener',timestamp:iso(NOW),text:'His full catalog and albums make him the greatest.'},
  ],records:records||[
    {threads_media_id:'parent',threads_published_at:iso(NOW-3600000),body:'Is Nas a top five rapper based on his music catalog?'},
  ],calls:[],saved:[clone(state)]};
  f.save=async()=>f.saved.push(clone(f.state));
  f.api={
    get:async(path,params)=>{
      f.calls.push({method:'GET',path,params});
      if(path==='/me')return {id:'account',username:'RapWire247'};
      if(path.endsWith('/replies'))return {data:f.comments};
      if(path==='/container')return {status:'FINISHED'};
      if(path==='/reply')return {id:'reply',text:f.state.pending.text,replied_to:{id:f.state.pending.target_id},permalink:'https://www.threads.net/@rapwire247/post/reply'};
      throw new Error('Unexpected GET '+path);
    },
    post:async(path,params)=>{
      f.calls.push({method:'POST',path,params});
      if(path==='/account/threads') {
        assert.equal(f.saved.at(-1).pending.target_id,params.reply_to_id,'persist target before creating the container');
        assert.equal(f.saved.at(-1).pending.text,params.text,'persist exact reply text before creating the container');
        return {id:'container'};
      }
      if(path==='/account/threads_publish') {
        assert.equal(f.saved.at(-1).pending.threads_container_id,params.creation_id);
        assert.equal(f.saved.at(-1).pending.threads_publish_requested_at,iso(f.now),'persist publish intent before sending it');
        return {id:'reply'};
      }
      throw new Error('Unexpected POST '+path);
    },
  };
  f.step=()=>engage({api:f.api,userId:'account',records:f.records,state:f.state,save:f.save,now:f.now});
  f.tick=(milliseconds=120000)=>f.now+=milliseconds;
  f.posts=()=>f.calls.filter(x=>x.method==='POST');
  return f;
}

test('reply container resumes from saved state and publishes only after its poll interval',async()=>{
  const f=fixture();
  assert.equal(await f.step(),'processing');
  assert.equal(f.state.pending.mode,'agree');
  assert.equal(f.state.pending.threads_container_id,'container');
  assert.equal(f.state.pending.target_id,'comment');
  f.state=clone(f.saved.at(-1)); // A later process reloads only durable state.
  assert.equal(await f.step(),'processing');
  assert.equal(f.posts().length,1);
  assert.equal(f.calls.filter(x=>x.path==='/container').length,0);
  f.tick();
  assert.equal(await f.step(),'verified');
  assert.equal(f.state.pending,undefined);
  assert.equal(f.state.replied_ids.comment.reply_id,'reply');
  assert.equal(f.state.replied_ids.comment.source_post_id,'parent');
  assert.equal(f.state.replied_ids.comment.mode,'agree');
  assert.equal(f.state.last_reply_at,iso(f.now));
  assert.equal(f.posts().length,2);
  assert.equal(await f.step(),'daily_or_interval_limit');
  assert.equal(f.posts().length,2);
});

test('a lost publish response survives restart without sending a duplicate',async()=>{
  const f=fixture();
  await f.step();f.tick();
  const post=f.api.post;
  f.api.post=async(path,params)=>{
    const result=await post(path,params);
    if(path.endsWith('/threads_publish'))throw new Error('Connection lost after accepting publish');
    return result;
  };
  await assert.rejects(f.step(),/Connection lost/);
  assert.ok(f.saved.at(-1).pending.threads_publish_requested_at);
  f.state=clone(f.saved.at(-1));
  f.tick();await assert.rejects(f.step(),/uncertain/);
  assert.equal(f.state.pending.threads_reconcile_required,true);
  f.tick();await assert.rejects(f.step(),/reconciliation/);
  assert.equal(f.posts().filter(x=>x.path.endsWith('/threads_publish')).length,1);
  assert.equal(f.posts().filter(x=>x.path.endsWith('/threads')).length,1);
});

for(const [field,mutate] of [
  ['ID',value=>({...value,id:'another-reply'})],
  ['text',value=>({...value,text:'Different response'})],
  ['target',value=>({...value,replied_to:{id:'another-comment'}})],
  ['missing target',value=>({...value,replied_to:undefined})],
]) {
  test(`readback rejects mismatched ${field} and retries verification without republishing`,async()=>{
    const f=fixture();
    await f.step();f.tick();
    const get=f.api.get;
    f.api.get=async(path,params)=>{
      const value=await get(path,params);
      return path==='/reply'?mutate(value):value;
    };
    await assert.rejects(f.step(),/readback did not match/);
    assert.equal(f.state.pending.threads_media_id,'reply');
    assert.equal(f.state.replied_ids.comment,undefined);
    f.state=clone(f.saved.at(-1));f.api.get=get;
    assert.equal(await f.step(),'verified');
    assert.equal(f.posts().filter(x=>x.path.endsWith('/threads_publish')).length,1);
  });
}

test('account identity must match both configured ID and the allowed username',async()=>{
  for(const profile of [{id:'wrong',username:'rapwire247'},{id:'account',username:'someone_else'}]) {
    const f=fixture();
    f.api.get=async()=>profile;
    await assert.rejects(f.step(),/does not match/);
    assert.equal(f.posts().length,0);
    assert.equal(f.state.pending,undefined);
  }
});

test('reply selection skips own, old, missing-identity, repeated and abusive comments',async()=>{
  const base={timestamp:iso(NOW),username:'listener',text:'His catalog makes him the greatest rapper of all time.'};
  const f=fixture({state:{replied_ids:{done:{at:iso(NOW),username:'already'}}},comments:[
    {...base,id:'self',is_reply_owned_by_me:true},
    {...base,id:'named-self',username:'RAPWIRE247'},
    {...base,id:'old',timestamp:iso(NOW-1)},
    {...base,id:'missing-name',username:''},
    {...base,id:'done'},
    {...base,id:'abuse',text:'You are an idiot if you disagree with this catalog ranking.'},
    {...base,id:'spam',text:'Follow me for the greatest music catalog giveaways.'},
    {...base,id:'eligible'},
  ]});
  assert.equal(await f.step(),'processing');
  assert.equal(f.state.pending.target_id,'eligible');
});

test('unrelated comments on a ranking post do not invite automated debate',async()=>{
  const f=fixture({comments:[{id:'unrelated',username:'listener',timestamp:iso(NOW),text:'My refrigerator delivery arrives tomorrow morning.'}]});
  assert.equal(await f.step(),'no_eligible_replies');
  assert.equal(f.posts().length,0);
});

test('context chooses agreement for catalog arguments and a challenge for sales arguments',async()=>{
  for(const [text,mode] of [
    ['His catalog and consistent albums make him the greatest.','agree'],
    ['His sales and streams make him the greatest rapper alive.','challenge'],
  ]) {
    const f=fixture({comments:[{id:'comment',username:'listener',timestamp:iso(NOW),text}]});
    await f.step();
    assert.equal(f.state.pending.mode,mode);
  }
});

test('daily, interval and participant limits hold without blocking an existing pending reply',async()=>{
  const recent=Array.from({length:12},(_,i)=>[String(i),{at:iso(NOW-1000),username:'user'+i}]);
  const daily=fixture({state:{replied_ids:Object.fromEntries(recent)}});
  assert.equal(await daily.step(),'daily_or_interval_limit');
  assert.equal(daily.calls.length,0);
  const interval=fixture({state:{last_reply_at:iso(NOW-29*60000)}});
  assert.equal(await interval.step(),'daily_or_interval_limit');
  assert.equal(interval.calls.length,0);
  const participant=fixture({state:{replied_ids:{one:{at:iso(NOW-1000),username:'listener',source_post_id:'parent'}}}});
  assert.equal(await participant.step(),'no_eligible_replies');
  assert.equal(participant.posts().length,0);
  const pending=fixture({state:{last_reply_at:iso(NOW),replied_ids:Object.fromEntries(recent),pending:{target_id:'comment',source_post_id:'parent',username:'listener',text:'Already selected response',mode:'clarify'}}});
  assert.equal(await pending.step(),'processing');
  assert.equal(pending.posts().length,1);
});

test('scanning is limited to three recent parents, rotates, and waits fifteen minutes',async()=>{
  const records=Array.from({length:5},(_,i)=>({threads_media_id:'parent'+i,threads_published_at:iso(NOW-(i+1)*3600000),body:'A music post.'}));
  records.push({threads_media_id:'stale',threads_published_at:iso(NOW-8*86400000)});
  const f=fixture({records,comments:[]});
  assert.equal(await f.step(),'no_eligible_replies');
  const scans=()=>f.calls.filter(x=>x.path.endsWith('/replies'));
  assert.deepEqual(scans().map(x=>x.path),['/parent0/replies','/parent1/replies','/parent2/replies']);
  assert.ok(scans().every(x=>x.params.limit==='25'));
  f.tick(14*60000);
  assert.equal(await f.step(),'scan_cooldown');
  assert.equal(scans().length,3);
  f.tick(60000);await f.step();
  assert.deepEqual(scans().slice(3).map(x=>x.path),['/parent3/replies','/parent4/replies','/parent0/replies']);
});

test('a failure persisting publish intent prevents the non-idempotent request',async()=>{
  const f=fixture();
  await f.step();f.tick();
  const save=f.save;
  f.save=async()=>{
    if(f.state.pending.threads_publish_requested_at)throw new Error('Disk unavailable');
    return save();
  };
  await assert.rejects(f.step(),/Disk unavailable/);
  assert.equal(f.posts().filter(x=>x.path.endsWith('/threads_publish')).length,0);
});
