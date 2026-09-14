import test from 'node:test';
import assert from 'node:assert/strict';
import {assessWatchdog} from './publisher-watchdog.mjs';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const item = {id:'ready-video', status:'ready'};

test('retry eligibility uses the supplied clock and protects uncertain publish requests', () => {
  const health={delivery_policy:{next_feed_eligible_at:new Date(NOW-16*60_000).toISOString()}};
  assert.equal(assessWatchdog({now:NOW,health,items:[{...item,instagram_retry_at:new Date(NOW+60000).toISOString()}]}).dispatch,false);
  assert.equal(assessWatchdog({now:NOW,health,items:[{...item,instagram_publish_requested_at:new Date(NOW-60000).toISOString()}]}).dispatch,false);
  assert.equal(assessWatchdog({now:NOW,health,items:[{...item,instagram_retry_at:new Date(NOW-60000).toISOString()}]}).dispatch,true);
});

test('watchdog dispatches one safe retry after a missed eligible window', () => {
  const outcome = assessWatchdog({now:NOW, health:{delivery_policy:{next_feed_eligible_at:new Date(NOW-16*60_000).toISOString()}},items:[item]});
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.reason, 'missed_feed_window');
});

test('watchdog does not wait a second grace window once feed is due', () => {
  const outcome = assessWatchdog({now:NOW, health:{delivery_policy:{next_feed_eligible_at:new Date(NOW-3*60_000).toISOString()}},items:[item]});
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.reason, 'missed_feed_window');
});

test('watchdog does not bypass Meta cooldowns or quotas', () => {
  const health={delivery_policy:{next_feed_eligible_at:new Date(NOW-16*60_000).toISOString()},instagram_publishing_quota:{blocked:true}};
  assert.equal(assessWatchdog({now:NOW,health,items:[item]}).dispatch, false);
});

test('watchdog leaves a healthy cadence alone', () => {
  const health={delivery_policy:{next_feed_eligible_at:new Date(NOW+10*60_000).toISOString()}};
  assert.equal(assessWatchdog({now:NOW,health,items:[item]}).dispatch, false);
});

test('watchdog restores the Threads video lane without waiting for Instagram', () => {
  const old = new Date(NOW - 31 * 60_000).toISOString();
  const outcome = assessWatchdog({now:NOW, items:[{
    id:'published-video', status:'published', content_type:'video', threads_media_id:'t1', threads_published_at:old
  }]});
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.reason, 'missed_threads_video_window');
});

test('watchdog recovers when the health snapshot is missing but a ready item exists', () => {
  const outcome = assessWatchdog({now:NOW, health:{}, items:[item]});
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.health_stale, true);
});

test('watchdog resumes a saved processing container after a dead publisher run', () => {
  const outcome = assessWatchdog({now:NOW, health:{checked_at:new Date(NOW-11*60_000).toISOString()}, items:[{
    ...item,
    instagram_container_id:'container',
    instagram_container_created_at:new Date(NOW-5*60_000).toISOString()
  }]});
  assert.equal(outcome.dispatch, true);
  assert.deepEqual(outcome.processing, [item.id]);
  assert.equal(outcome.reason, 'stalled_container');
});

test('watchdog dispatches a pending Threads video even when Instagram is within cadence', () => {
  const outcome = assessWatchdog({now:NOW, health:{checked_at:new Date(NOW-2*60_000).toISOString()}, items:[{
    ...item, content_type:'video', threads_status:'pending'
  }]});
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.threads_pending, true);
});
