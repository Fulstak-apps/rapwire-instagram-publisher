import test from 'node:test';
import assert from 'node:assert/strict';
import {threadsTopicTag} from './audience-policy.mjs';

test('all generic Threads topics use Rap Threads', () => {
  for (const text of ['', 'Hip-hop culture', 'New album release', 'Court trial update', 'GTA 6 gaming']) {
    assert.equal(threadsTopicTag(text), 'Rap Threads');
  }
});

test('identified artist keeps the artist topic', () => {
  assert.equal(threadsTopicTag('Drake new album', {
    artistMentions: [{name: 'Drake', handle: 'champagnepapi'}],
  }), 'Drake');
});
