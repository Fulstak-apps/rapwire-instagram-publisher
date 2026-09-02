import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceContainer } from './container-state.mjs';

function fixture(item = {}) {
  let now = Date.parse('2026-09-02T05:00:00Z');
  const calls = { create: 0, inspect: 0, publish: 0, save: [] };
  const options = { item, prefix: 'instagram',
    create: async () => { calls.create++; return { id: 'container' }; },
    inspect: async () => { calls.inspect++; return { status_code: 'FINISHED' }; },
    publish: async () => { calls.publish++; return { id: 'media' }; },
    save: async () => calls.save.push(structuredClone(item))
  };
  return { item, calls, options, tick: (ms = 120000) => now += ms, step: () => advanceContainer({ ...options, now }) };
}

test('create saves ID; no immediate poll; publish once after interval', async () => {
  const f = fixture();
  assert.equal(await f.step(), null);
  assert.equal(f.item.instagram_container_id, 'container');
  await f.step();
  assert.equal(f.calls.inspect, 0);
  f.tick();
  assert.equal((await f.step()).id, 'media');
  assert.ok(f.calls.save.some(x => x.instagram_publish_requested_at && !x.instagram_media_id));
  await f.step();
  assert.equal(f.calls.publish, 1);
});

test('slow processing remains queued beyond former fifteen-minute cutoff', async () => {
  const f = fixture();
  await f.step(); f.tick(3600000);
  f.options.inspect = async () => ({ status_code: 'IN_PROGRESS' });
  assert.equal(await f.step(), null);
  assert.equal(f.item.instagram_container_id, 'container');
  assert.equal(f.item.status, undefined);
  assert.equal(f.calls.create, 1);
});

test('definitive rate-limit rejection clears request marker and reuses container', async () => {
  const f = fixture(); await f.step(); f.tick();
  const publish = f.options.publish;
  f.options.publish = async () => { throw Object.assign(new Error('rate limit'), { definitiveRejection: true }); };
  await assert.rejects(f.step(), /rate limit/);
  assert.equal(f.item.instagram_publish_requested_at, undefined);
  f.options.publish = publish; f.tick(); await f.step();
  assert.equal(f.calls.create, 1);
  assert.equal(f.item.instagram_media_id, 'media');
});

test('lost response never triggers blind duplicate publication', async () => {
  const f = fixture(); await f.step(); f.tick();
  f.options.publish = async () => { f.calls.publish++; throw new Error('timeout'); };
  await assert.rejects(f.step(), /timeout/);
  f.tick(); await assert.rejects(f.step(), /uncertain/);
  f.tick(); await assert.rejects(f.step(), /reconciliation/);
  assert.equal(f.calls.publish, 1);
  assert.equal(f.item.instagram_reconcile_required, true);
});

test('confirmed EXPIRED container gets a delayed replacement, never immediate retry', async () => {
  const f = fixture(); await f.step(); f.tick();
  f.options.inspect = async () => ({ status_code: 'EXPIRED' });
  await assert.rejects(f.step(), /EXPIRED/);
  assert.equal(f.item.instagram_container_id, undefined);
  await f.step(); assert.equal(f.calls.create, 1);
  f.tick(30 * 60000); await f.step(); assert.equal(f.calls.create, 2);
});

test('already PUBLISHED container requires reconciliation, not recreation', async () => {
  const f = fixture(); await f.step(); f.tick();
  f.options.inspect = async () => ({ status_code: 'PUBLISHED' });
  await assert.rejects(f.step(), /uncertain/);
  assert.equal(f.calls.publish, 0); assert.equal(f.calls.create, 1);
});

for (const prefix of ['instagram_story', 'threads']) {
  test(`${prefix} persists separately and survives a restarted run`, async () => {
    const f = fixture(); f.options.prefix = prefix;
    await f.step(); f.tick();
    f.options.inspect = async () => ({ status: 'FINISHED' });
    await f.step();
    assert.equal(f.item[`${prefix}_media_id`], 'media');
    assert.equal(f.item.instagram_media_id, undefined);
  });
}
