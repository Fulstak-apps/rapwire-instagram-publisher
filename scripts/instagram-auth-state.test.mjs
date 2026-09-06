import test from 'node:test';
import assert from 'node:assert/strict';
import {isInstagramAuthFailureReason, recoverQuotaAfterValidAuth, checkInstagramIdentity} from './instagram-auth-state.mjs';

test('recognizes Meta code 190 auth failures without confusing quota exhaustion', () => {
  assert.equal(isInstagramAuthFailureReason('Error validating access token: session has been invalidated. OAuthException code 190'), true);
  assert.equal(isInstagramAuthFailureReason('Instagram publishing quota exhausted (9/2207042)'), false);
});

test('valid auth clears only a stale auth-created quota hold', () => {
  const now = Date.parse('2026-09-06T17:00:00Z');
  const stale = recoverQuotaAfterValidAuth({
    blocked: true,
    next_check_at: '2026-09-06T18:00:00Z',
    reason: 'Quota check unavailable: {"error":{"message":"Error validating access token","code":190}}'
  }, now);
  assert.equal(stale.changed, true);
  assert.equal(stale.quota.blocked, false);
  assert.equal(stale.quota.next_check_at, null);
  assert.equal(stale.quota.auth_recovered_at, '2026-09-06T17:00:00.000Z');

  const realQuotaHold = recoverQuotaAfterValidAuth({blocked: true, reason: 'Instagram publishing quota exhausted (9/2207042)'}, now);
  assert.equal(realQuotaHold.changed, false);
  assert.equal(realQuotaHold.quota.blocked, true);
});

test('identity check requires the configured Instagram user ID', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return {user_id: '12345', username: 'rapwire247'}; }
  });
  const good = await checkInstagramIdentity({token: 'test-token', userId: '12345', fetchImpl});
  assert.equal(good.valid, true);
  assert.equal(good.username, 'rapwire247');

  const wrong = await checkInstagramIdentity({token: 'test-token', userId: '99999', fetchImpl});
  assert.equal(wrong.valid, false);
  assert.match(wrong.message, /identity mismatch/i);
});
