import test from 'node:test';
import assert from 'node:assert/strict';
import { isRecentStoryDuplicate, storySimilarity } from './content-pacing.mjs';

const now = Date.parse('2026-10-03T12:00:00Z');
test('holds near-identical updates on the same developing story for six hours', () => {
  const published = [{ published_at: new Date(now - 60 * 60_000).toISOString(), body: 'Kai Cenat says he is suing Reggie after their public dispute.' }];
  assert.ok(storySimilarity('Kai Cenat explains why he is taking legal action against Reggie.', published[0].body) >= 0.33);
  assert.equal(isRecentStoryDuplicate({ body: 'Kai Cenat explains why he is taking legal action against Reggie.' }, published, { now }), true);
});
test('allows a genuinely different rap story and lets an old story return only after its hold window', () => {
  const published = [{ published_at: new Date(now - 7 * 60 * 60_000).toISOString(), body: 'Kai Cenat says he is suing Reggie after their public dispute.' }];
  assert.equal(isRecentStoryDuplicate({ body: 'Drake announces a new release date for his upcoming album.' }, published, { now }), false);
  assert.equal(isRecentStoryDuplicate({ body: 'Kai Cenat explains why he is taking legal action against Reggie.' }, published, { now }), false);
});
