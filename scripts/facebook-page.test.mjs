import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFacebookPage,facebookMedia} from './facebook-page.mjs';

test('publishes and verifies one Page video after persisting intent',async()=>{
  const item={};const calls=[];let savedIntent=false;
  const api={post:async(path,fields)=>{assert.equal(savedIntent,true);calls.push(['post',path,fields]);return{id:'v1'}},get:async()=>({id:'v1',permalink_url:'https://facebook.test/v1'})};
  const result=await deliverFacebookPage({item,api,pageId:'42',caption:'copy',media:[{type:'video',url:'https://media.test/v.mp4'}],save:async()=>{savedIntent=Boolean(item.facebook_publish_requested_at)}});
  assert.equal(result.status,'published');assert.equal(item.facebook_verified_at!==undefined,true);
  assert.deepEqual(calls[0],['post','/42/videos',{file_url:'https://media.test/v.mp4',description:'copy'}]);
});

test('resumes verification but never republishes after a persisted request',async()=>{
  const item={facebook_publish_requested_at:'2026-01-01T00:00:00Z'};let posted=false;
  const result=await deliverFacebookPage({item,api:{post:async()=>{posted=true}},pageId:'42',caption:'x',media:[{type:'video',url:'x'}],save:async()=>{}});
  assert.equal(result.status,'reconciliation_required');assert.equal(posted,false);
});

test('uploads image children unpublished before creating the Page carousel',async()=>{
  const item={};const calls=[];let id=0;
  const api={post:async(path,fields)=>{calls.push([path,fields]);return path.endsWith('/feed')?{id:'post1'}:{id:`p${++id}`}},get:async()=>({id:'post1'})};
  await deliverFacebookPage({item,api,pageId:'42',caption:'news',media:[{type:'image',url:'a'},{type:'image',url:'b'}],save:async()=>{}});
  assert.equal(calls[0][1].published,'false');assert.equal(calls[1][1].published,'false');
  assert.equal(calls[2][0],'/42/feed');assert.equal(calls[2][1].attached_media,'[{"media_fbid":"p1"},{"media_fbid":"p2"}]');
});

test('holds mixed media rather than publishing an incomplete Facebook copy',async()=>{
  const item={};let posted=false;
  const result=await deliverFacebookPage({item,api:{post:async()=>{posted=true}},pageId:'42',caption:'x',media:[{type:'image',url:'a'},{type:'video',url:'b'}],save:async()=>{}});
  assert.equal(result.status,'review_required');assert.equal(posted,false);
});

test('builds media from videos, slides, and repost media',()=>{
  const urls={mediaUrl:p=>`m:${p}`,slideUrl:(_,i)=>`s:${i}`,videoUrl:()=>`v`};
  assert.deepEqual(facebookMedia({content_type:'video'},urls),[{type:'video',url:'v'}]);
  assert.deepEqual(facebookMedia({slides:['a','b']},urls),[{type:'image',url:'s:0'},{type:'image',url:'s:1'}]);
  assert.deepEqual(facebookMedia({media_items:[{type:'video',path:'x'}]},urls),[{type:'video',url:'m:x'}]);
});
