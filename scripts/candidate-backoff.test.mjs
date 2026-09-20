import test from 'node:test';
import assert from 'node:assert/strict';
import {failedCandidates} from './candidate-backoff.mjs';
test('bad candidate yields to alternatives and becomes eligible later', () => {
  const now = Date.now();
  const runs = [{finished_at:new Date(now-3600000).toISOString(), errors:[
    {stage:'queue',source_url:'https://www.instagram.com/p/bad/',error:'Caption needs editorial review'},
    {stage:'queue',source_url:'https://www.instagram.com/reel/network/',error:'network timeout'}]}];
  assert.deepEqual([...failedCandidates(runs,now)],['bad']);
  assert.equal(failedCandidates(runs,now+6*3600000).size,0);
});
