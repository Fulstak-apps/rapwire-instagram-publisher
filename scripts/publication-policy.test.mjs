import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationPolicy, recoveryPolicy } from './publication-policy.mjs';
const now = Date.parse('2026-09-02T15:00:00Z');
const feed = {status:'published',content_type:'video',instagram_media_id:'feed',published_at:new Date(now-30*60000).toISOString(),instagram_story_status:'published',instagram_story_media_id:'story',instagram_story_published_at:new Date(now-5*60000).toISOString()};
test('30-minute boundary uses the feed time, not the more recent Story time', () => {
  assert.equal(publicationPolicy([feed],{now:now-1}).feed_allowed,false);
  assert.equal(publicationPolicy([feed],{now}).feed_allowed,true);
});
test('persisted feed timestamp survives missing queue history', () => {
  assert.equal(publicationPolicy([],{now,lastFeedPublishedAt:new Date(now-10*60000).toISOString()}).feed_allowed,false);
});
test('reserve both the new Story and unfinished older Stories before starting another feed', () => {
  const pending={...feed,instagram_story_media_id:undefined,instagram_story_status:'pending'};
  assert.equal(publicationPolicy([pending],{now,quota:{usage:30,total:100}}).feed_allowed,false);
  assert.equal(publicationPolicy([pending],{now,quota:{usage:29,total:100}}).feed_allowed,true);
});
test('one remaining slot can finish a Story but cannot start another video/Story pair', () => {
  const p=publicationPolicy([],{now,quota:{usage:31,total:100}});
  assert.equal(p.story_allowed,true); assert.equal(p.feed_allowed,false);
  assert.equal(publicationPolicy([],{now,quota:{usage:32,total:100}}).story_allowed,false);
});
test('lower platform limits reduce our budget; duplicate IDs are counted once', () => {
  const p=publicationPolicy([feed,feed],{now,quota:{usage:1,total:100,effective_total:20}});
  assert.equal(p.instagram_usage,2); assert.equal(p.instagram_daily_cap,16);
});
test('published records age out of the rolling budget', () => {
  const old={...feed,published_at:new Date(now-25*3600000).toISOString(),instagram_story_published_at:new Date(now-25*3600000).toISOString()};
  assert.equal(publicationPolicy([old],{now}).instagram_usage,0);
});
const authorization={mode:'one-feed-and-story',item_id:'recovery',authorized_at:new Date(now-60000).toISOString(),expires_at:new Date(now+1800000).toISOString()};
const quota={usage:43,total:100,effective_total:50,blocked:false,checked_at:new Date(now).toISOString()};
test('one recovery pair may use confirmed headroom without resetting normal cap', () => {
  const ready={id:'recovery',status:'ready'};
  assert.equal(recoveryPolicy([ready],{authorization,quota,now}).feed_allowed,true);
  assert.equal(publicationPolicy([ready],{quota,now}).feed_allowed,false);
  assert.equal(recoveryPolicy([ready],{authorization,quota,now,lastFeedPublishedAt:new Date(now-60000).toISOString()}).feed_allowed,false);
});
test('recovery never overrides blocked, stale, expired, or insufficient quota', () => {
  const records=[{id:'recovery',status:'ready'}];
  for(const q of [{...quota,blocked:true},{...quota,usage:47},{...quota,checked_at:new Date(now-300000).toISOString()}]) {
    assert.equal(recoveryPolicy(records,{authorization,quota:q,now}).feed_allowed,false);
  }
  assert.equal(recoveryPolicy(records,{authorization:{...authorization,expires_at:new Date(now-1).toISOString()},quota,now}).feed_allowed,false);
});
test('recovery finishes only the named Story and cannot publish a second pair', () => {
  const published={...feed,id:'recovery',instagram_story_media_id:undefined,instagram_story_status:'pending'};
  const p=recoveryPolicy([published],{authorization,quota,now});
  assert.equal(p.feed_allowed,false); assert.equal(p.story_allowed,true);
  assert.equal(recoveryPolicy([{...published,instagram_story_media_id:'done'}],{authorization,quota,now}).story_allowed,false);
  assert.equal(recoveryPolicy([{...published,id:'another'}],{authorization,quota,now}).story_allowed,false);
});
