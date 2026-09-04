import assert from 'node:assert/strict';
import test from 'node:test';
import {FACEBOOK_CONVERSATION_INTERVAL,publishFacebookConversation} from './facebook-conversations.mjs';

const NOW=Date.parse('2026-09-04T12:00:00Z');
test('publishes one verified text-only Page conversation and observes cadence',async()=>{
  const state={},saved=[],posts=[];
  const api={
    post:async(path,params)=>{posts.push({path,params});return {post_id:'page_1'};},
    get:async(path)=>({id:'page_1',permalink_url:'https://facebook.test/page_1',message:state.pending.text})
  };
  const save=async()=>saved.push(structuredClone(state));
  assert.equal(await publishFacebookConversation({api,pageId:'page',state,save,now:NOW}),'verified');
  assert.equal(posts[0].path,'/page/feed');
  assert.match(posts[0].params.message,/@rapwire247$/);
  assert.equal(await publishFacebookConversation({api,pageId:'page',state,save,now:NOW+FACEBOOK_CONVERSATION_INTERVAL-1}),'interval_limit');
});
