import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionPrompt} from './audience-policy.mjs';
test('broad music context does not invent project comparison questions', () => {
  for(let seed=0;seed<100;seed++) {
    assert.equal(discussionPrompt('A rapper shared a video from his birthday party.', String(seed)), '');
    assert.equal(discussionPrompt('Two artists discuss music in this interview.', String(seed)), '');
  }
});
