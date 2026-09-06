import test from 'node:test';
import assert from 'node:assert/strict';
import {assessWatchdog} from './publisher-watchdog.mjs';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const item = {id:'ready-video', status:'ready'};

test('watchdog dispatches one safe retry after a missed eligible window', () => {
  const outcome = assessWatchdog({now:NOW, health:{delivery_policy:{next_feed_eligible_at:new Date(NOW-16*60_000).toISOString()}},items:[item]});
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
