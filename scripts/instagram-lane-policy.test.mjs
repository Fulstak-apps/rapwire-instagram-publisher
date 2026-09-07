import test from 'node:test';
import assert from 'node:assert/strict';
import {storyCanRun, shouldPreferStory} from './instagram-lane-policy.mjs';
test('review-required Story cannot reserve the Instagram lane', () => {
  assert.equal(storyCanRun({status:'published',instagram_story_status:'review_required'}), false);
  assert.equal(storyCanRun({status:'published'}), true);
});
test('overdue feed wins even when a Story is pending', () => {
  const state={storyAllowed:true,feedAllowed:true,recoveryFeedAllowed:false,pendingStory:true,lastLane:'feed'};
  assert.equal(shouldPreferStory(state),false);
  assert.equal(shouldPreferStory({...state,feedAllowed:false}),true);
});
