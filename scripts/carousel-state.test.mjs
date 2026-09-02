import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceMediaPost} from './carousel-state.mjs';
const media=[{type:'image'},{type:'video'}];
function setup(item={}) {
 let now=Date.now(),children=0,parents=0,published=0;
 const options={item,prefix:'instagram',media,createChild:async m=>({id:`${m.type}-${++children}`}),createParent:async ids=>{assert.deepEqual(ids,['image-1','video-2']);parents++;return{id:'parent'};},createSingle:async()=>({id:'single'}),inspect:async()=>({status_code:'FINISHED'}),publish:async()=>{published++;return{id:'live'};},save:async()=>{}};
 return {options,item,tick:()=>now+=180000,run:()=>advanceMediaPost({...options,now}),counts:()=>({children,parents,published})};
}
test('mixed carousel resumes uploaded children and publishes the parent once',async()=>{
 const s=setup();
 assert.equal(await s.run(),null);assert.equal(s.item.instagram_children.length,2);
 s.tick();assert.equal(await s.run(),null);assert.equal(s.item.instagram_container_id,'parent');
 s.tick();assert.equal((await s.run()).id,'live');
 assert.equal((await s.run()).id,'live');assert.deepEqual(s.counts(),{children:2,parents:1,published:1});
});
test('interruption after first child preserves it for retry',async()=>{
 const s=setup();const original=s.options.createChild;
 let failed=false;
 s.options.createChild=async(m,i)=>{if(i===1&&!failed){failed=true;throw new Error('connection lost');}return original(m);};
 await assert.rejects(s.run(),/connection lost/);assert.equal(s.item.instagram_children[0].id,'image-1');
 await s.run();assert.equal(s.item.instagram_children[1].id,'video-2');assert.equal(s.counts().children,2);
});
test('uncertain carousel publish is never retried automatically',async()=>{
 const s=setup();await s.run();s.tick();await s.run();s.tick();
 s.options.publish=async()=>{throw new Error('network timeout');};
 await assert.rejects(s.run(),/network timeout/);
 assert.ok(s.item.instagram_publish_requested_at);
 s.tick();await assert.rejects(s.run(),/uncertain/);assert.equal(s.item.instagram_reconcile_required,true);
});
test('single photo uses an individual container',async()=>{
 const s=setup();s.options.media=[media[0]];
 await s.run();assert.equal(s.item.instagram_container_id,'single');assert.equal(s.item.instagram_children,undefined);
 s.tick();assert.equal((await s.run()).id,'live');
});
