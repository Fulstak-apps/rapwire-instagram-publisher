import test from 'node:test';
import assert from 'node:assert/strict';
import {ingest,payload,collect,publishOne} from './x-threads-mirror.mjs';
test('backfills only latest ten and never duplicates',()=>{
  const state={};const response={data:Array.from({length:12},(_,i)=>({id:String(i+1),text:'A rap post'}))};
  ingest(state,response,true);assert.equal(Object.keys(state.items).length,10);assert.equal(state.items['1'],undefined);
  ingest(state,response,true);assert.equal(Object.keys(state.items).length,10);
});
test('retains media order and uses actual video instead of thumbnails',()=>{
  const state={};ingest(state,{data:[{id:'1',text:'Music history',attachments:{media_keys:['v','p']}}],includes:{media:[
    {media_key:'v',type:'video',variants:[{content_type:'video/mp4',bit_rate:100,url:'https://video.twimg.com/a.mp4'}]},
    {media_key:'p',type:'photo',url:'https://pbs.twimg.com/a.jpg'}]}});
  assert.deepEqual(payload(state.items['1']).assets.map(a=>a.media_type),['VIDEO','IMAGE']);
  assert.throws(()=>payload({text:'Caption',assets:[{type:'video',preview_image_url:'thumbnail'}]}),/playable/);
});
test('does not silently truncate long captions',()=>assert.throws(()=>payload({text:'a'.repeat(501),assets:[]}),/500/));
test('incomplete expansions never advance the cursor',()=>assert.throws(()=>ingest({}, {errors:[{title:'Missing media'}]}),/cursor/));
test('first successful collection sets ten-post baseline and next collection uses since ID',async()=>{
  const state={},calls=[];let now=Date.now();
  const get=async(path,params)=>{calls.push({path,params});return path.includes('username')?{data:{username:'RapWikip',id:'account'}}:{data:[{id:'9',text:'History'}]};};
  await collect(state,get,async()=>{},now);assert.equal(state.since_id,'9');assert.equal(state.initialized,true);
  await collect(state,get,async()=>{},now+16*60000);assert.equal(calls.at(-1).params.since_id,'9');
});
test('quota hold makes no publish calls and cannot touch Instagram',async()=>{
  const api={get:async path=>path==='/me'?{id:'t',username:'rapwire247'}:{data:[{quota_usage:200,config:{quota_total:250}}]},post:()=>{throw new Error('must not publish');}};
  assert.equal(await publishOne({items:{}},api,async()=>{}),'quota_hold');
});
test('wrong Threads account fails closed',async()=>{
  await assert.rejects(()=>publishOne({}, {get:async()=>({username:'wrong'})},async()=>{}),/identity/);
});
