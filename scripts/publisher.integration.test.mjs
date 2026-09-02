import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script = path.resolve('scripts/publish-instagram.mjs');
const body = 'This is a verified video with a complete descriptive caption.';
const item = { id: 'test', status: 'published', content_type: 'video', video: 'media/test.mp4', source_handle: 'akademiks', source_url:'https://www.instagram.com/akademiks/reel/ExactPost/', caption_policy:'exact-source-v1', caption_source_shortcode:'ExactPost', source_caption_text:body, body, rendered_body_text: body, caption: body, threads_text: body, layout_template: 'rapwire-video-grid-safe-v1', source_policy_checked: true, rap_relevance_checked: true, content_claim_checked: true, editorial_substance_checked: true, text_overflow_checked: true, instagram_media_id: 'existing', threads_status: 'pending' };
function run(t, record, cooldown, mock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapwire-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'queue')); fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'queue/test.json'), JSON.stringify(record));
  if(cooldown) fs.writeFileSync(path.join(dir,'logs/instagram-cooldown.json'), JSON.stringify(cooldown));
  const preload = `globalThis.fetch = async (url, options = {}) => { if(String(url).includes('/content_publishing_limit?')) return new Response(JSON.stringify({data:[{quota_usage:1,config:{quota_total:50}}]})); ${mock} };`;
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script], { cwd: dir, encoding: 'utf8', env: { ...process.env, INSTAGRAM_ACCESS_TOKEN:'fake', INSTAGRAM_USER_ID:'fake', THREADS_ACCESS_TOKEN:'fake', THREADS_USER_ID:'fake', GITHUB_REPOSITORY:'test/test', PUBLISH_INSTAGRAM_STORIES:'true', GITHUB_STEP_SUMMARY:'' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { item: JSON.parse(fs.readFileSync(path.join(dir,'queue/test.json'))), report: JSON.parse(fs.readFileSync(path.join(dir,'logs/publisher-health.json'))) };
}
test('Instagram cooldown does not block pending Threads work', t => {
  const r = run(t, item, { until: new Date(Date.now()+3600000).toISOString() }, `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('Unexpected IG call during cooldown'); return new Response(JSON.stringify({id:'threads-container'}));`);
  assert.equal(r.item.threads_container_id, 'threads-container');
  assert.equal(r.report.instagram_steps, 0); assert.equal(r.report.threads_steps, 1);
  assert.equal(r.report.publications.length, 0);
});
test('timed-out Story resumes its saved container without recreating', t => {
  const r = run(t, { ...item, threads_status:'published', threads_media_id:'thread', instagram_story_status:'failed', instagram_story_error:'Instagram container 123 did not finish in time' }, null,
    `if(options.method === 'POST') throw new Error('Should only inspect pending Story'); return new Response(JSON.stringify({status_code:'IN_PROGRESS'}));`);
  assert.equal(r.item.instagram_story_container_id, '123');
  assert.equal(r.item.instagram_story_status, 'pending');
  assert.equal(r.report.instagram_steps, 1);
});
test('finished Reel records actual publication ID and readback permalink', t => {
  const r = run(t, { ...item, status:'ready', instagram_media_id:undefined, instagram_container_id:'container', instagram_container_created_at:'2026-01-01T00:00:00Z', threads_status:'published', threads_media_id:'thread' }, null,
    `if(options.method === 'POST') return new Response(JSON.stringify({id:'published-media'})); if(String(url).includes('/container?')) return new Response(JSON.stringify({status_code:'FINISHED'})); return new Response(JSON.stringify({id:'published-media', permalink:'https://www.instagram.com/p/confirmed/'}));`);
  assert.equal(r.item.status, 'published');
  assert.equal(r.item.instagram_permalink,'https://www.instagram.com/p/confirmed/');
  assert.equal(r.report.publications.length,1);
  assert.equal(r.item.instagram_story_container_id, undefined);
});
