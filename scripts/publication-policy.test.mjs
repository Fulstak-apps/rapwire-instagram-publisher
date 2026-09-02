import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationPolicy } from './publication-policy.mjs';
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
