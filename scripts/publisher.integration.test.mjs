import test from 'node:test';
import assert from 'node:assert/strict';
import {vipCaption} from './vip-policy.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script = path.resolve('scripts/publish-instagram.mjs');
const body = 'This is a verified video with a complete descriptive caption.';
const item = { caption_style:'source-tag-v1', id: 'test', status: 'published', content_type: 'video', video: 'media/test.mp4', source_handle: 'akademiks', source_url:'https://www.instagram.com/akademiks/reel/ExactPost/', caption_policy:'exact-source-v1', caption_source_shortcode:'ExactPost', source_caption_text:body, body, rendered_body_text: body, caption: body, threads_text: body, layout_template: 'rapwire-video-grid-safe-v1', source_policy_checked: true, rap_relevance_checked: true, content_claim_checked: true, editorial_substance_checked: true, text_overflow_checked: true, instagram_media_id: 'existing', threads_status: 'pending' };
function run(t, record, cooldown, mock, expectedStatus = 0, quotaState = null, usage = 1, total = 50, otherRecords = [], recovery = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapwire-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'queue')); fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'queue/test.json'), JSON.stringify(record));
  for(const extra of otherRecords) fs.writeFileSync(path.join(dir, `queue/${extra.id}.json`), JSON.stringify(extra));
  if(cooldown) fs.writeFileSync(path.join(dir,'logs/instagram-cooldown.json'), JSON.stringify(cooldown));
  if(quotaState) fs.writeFileSync(path.join(dir,'logs/instagram-publishing-quota.json'), JSON.stringify(quotaState));
  if(recovery) fs.writeFileSync(path.join(dir,'logs/instagram-recovery.json'),JSON.stringify(recovery));
  const preload = `globalThis.fetch = async (url, options = {}) => { if(String(url).includes('/content_publishing_limit?')) return new Response(JSON.stringify({data:[{quota_usage:${usage},config:{quota_total:${total}}}]})); ${mock} };`;
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script], { cwd: dir, encoding: 'utf8', env: { ...process.env, INSTAGRAM_ACCESS_TOKEN:'fake', INSTAGRAM_USER_ID:'fake', THREADS_ACCESS_TOKEN:'fake', THREADS_USER_ID:'fake', GITHUB_REPOSITORY:'test/test', PUBLISH_INSTAGRAM_STORIES:'true', GITHUB_STEP_SUMMARY:'' } });
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  return { item: JSON.parse(fs.readFileSync(path.join(dir,'queue/test.json'))), report: JSON.parse(fs.readFileSync(path.join(dir,'logs/publisher-health.json'))) };
}
test('Instagram cooldown does not block pending Threads work', t => {
  const r = run(t, item, { until: new Date(Date.now()+3600000).toISOString() }, `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('Unexpected IG call during cooldown'); return new Response(JSON.stringify({id:'threads-container'}));`);
  assert.equal(r.item.threads_container_id, 'threads-container');
  assert.equal(r.report.instagram_steps, 0); assert.equal(r.report.threads_steps, 1);
  assert.equal(r.report.publications.length, 0);
});
test('VIP short AI caption publishes without newsroom scoring while IG remains held', t => {
  const copy=vipCaption('AI',item.source_handle,item.source_url);
  const record={...item,...copy,status:'ready',instagram_media_id:undefined,rendered_body_text:copy.body,
    caption_policy:'vip-source-v1',source_caption_text:'AI',vip_source_checked:true};
  const r=run(t,record,null,
    `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('IG stays held'); return new Response(JSON.stringify({id:'vip-container'}));`,0,
    {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()});
  assert.equal(r.item.threads_container_id,'vip-container');
  assert.equal(r.report.threads_steps,1);
});
test('VIP bypass cannot authorize a non-VIP page', t => {
  const copy=vipCaption('AI',item.source_handle,item.source_url);
  const record={...item,...copy,source_handle:'unapproved',status:'ready',instagram_media_id:undefined,rendered_body_text:copy.body,
    caption_policy:'vip-source-v1',source_caption_text:'AI',vip_source_checked:true};
  const r=run(t,record,null,`throw new Error('No unapproved media allowed');`,0,
    {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()});
  assert.equal(r.report.threads_steps,0);
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
test('publish-limit rejection creates an account-wide quota hold and clears request marker', t => {
  const r = run(t, { ...item, status:'ready', instagram_media_id:undefined, instagram_container_id:'container', threads_status:'published', threads_media_id:'thread' }, null,
    `if(options.method === 'POST') return new Response(JSON.stringify({error:{code:9,error_subcode:2207042,message:'Media Publish Limit Exceeded'}}), {status:400}); return new Response(JSON.stringify({status_code:'FINISHED'}));`, 1);
  assert.equal(r.report.instagram_publishing_quota.blocked,true);
  assert.equal(r.item.instagram_publish_requested_at,undefined);
  assert.equal(r.report.publications.length,0);
});
test('advertised quota headroom does not override a recent actual rejection', t => {
  const r = run(t, { ...item, threads_status:'published', threads_media_id:'thread' }, null,
    `throw new Error('No publishing calls allowed while enforced quota is full');`, 0,
    {usage:50,total:100,blocked:true,detected_at:new Date().toISOString(),reason:'Instagram publishing quota exhausted (9/2207042)'}, 50, 100);
  assert.equal(r.report.instagram_publishing_quota.blocked,true);
  assert.equal(r.report.instagram_publishing_quota.effective_total,50);
  assert.equal(r.report.instagram_steps,0);
});
test('quota hold releases when usage falls below the observed rejection ceiling', t => {
  const r = run(t, { ...item, threads_status:'published',threads_media_id:'thread',instagram_story_status:'published',instagram_story_media_id:'story' }, null,
    `throw new Error('No unfinished posts expected');`, 0,
    {usage:50,total:100,blocked:true,observed_rejection_at_usage:50,detected_at:new Date().toISOString()}, 49, 100);
  assert.equal(r.report.instagram_publishing_quota.blocked,false);
  assert.equal(r.report.instagram_publishing_quota.usage,49);
});
test('old mismatched caption cannot occupy the only active upload slot', t => {
  const r = run(t, { ...item, status:'ready',instagram_media_id:undefined,threads_status:'published',threads_media_id:'thread' }, null,
    `if(options.method === 'POST') return new Response(JSON.stringify({id:'new-container'})); throw new Error('No polling expected');`, 0,null,1,50,
    [{...item,id:'old',status:'ready',instagram_media_id:undefined,instagram_container_id:'held-container',caption_policy:undefined}]);
  assert.equal(r.item.instagram_container_id,'new-container');
  assert.equal(r.report.instagram_steps,1);
});
test('recent feed publication blocks the next feed but not Threads delivery', t => {
  const r = run(t,{...item,status:'ready',instagram_media_id:undefined,instagram_container_id:'waiting-feed'},null,
    `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('Feed must wait 10 minutes'); return new Response(JSON.stringify({id:'threads-container'}));`,0,null,1,50,
    [{...item,id:'recent',published_at:new Date(Date.now()-5*60000).toISOString(),instagram_story_media_id:'story',instagram_story_status:'published'}]);
  assert.equal(r.item.status,'ready'); assert.equal(r.report.instagram_steps,0); assert.equal(r.report.threads_steps,1);
  assert.equal(r.report.delivery_policy.feed_interval_minutes,10);
});
test('daily safety budget prevents uploads even when Meta reports spare capacity', t => {
  const r = run(t,{...item,status:'ready',instagram_media_id:undefined,threads_status:'published',threads_media_id:'thread'},null,
    `throw new Error('No platform work expected at the daily safety cap');`,0,null,32,100);
  assert.equal(r.report.instagram_steps,0); assert.equal(r.report.delivery_policy.instagram_daily_cap,32);
  assert.equal(r.item.instagram_container_id,undefined);
});
test('ready video publishes on Threads while Instagram quota is exhausted', t => {
  const r=run(t,{...item,status:'ready',instagram_media_id:undefined,threads_container_id:'threads-container'},null,
    `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('Instagram must remain held'); if(options.method==='POST') return new Response(JSON.stringify({id:'thread-live'})); if(String(url).includes('/threads-container?')) return new Response(JSON.stringify({status:'FINISHED'})); return new Response(JSON.stringify({id:'thread-live',permalink:'https://www.threads.net/@rapwire247/post/verified'}));`,0,
    {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()});
  assert.equal(r.item.status,'ready'); assert.equal(r.item.instagram_media_id,undefined);
  assert.equal(r.item.threads_media_id,'thread-live'); assert.match(r.item.threads_permalink,/verified/);
  assert.equal(r.report.instagram_steps,0); assert.equal(r.report.publications.length,1);
});
test('new independent Threads publications still respect the 10-minute cadence', t => {
  const r=run(t,{...item,status:'ready',instagram_media_id:undefined},null,
    `throw new Error('No additional publish requests allowed during cadence hold');`,0,
    {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()},1,50,
    [{...item,id:'recent-thread',threads_media_id:'previous-thread',threads_status:'published',threads_published_at:new Date(Date.now()-60000).toISOString()}]);
  assert.equal(r.report.threads_steps,0); assert.equal(r.item.threads_container_id,undefined);
});
test('bad caption cannot bypass validation via independent Threads delivery', t => {
  const r=run(t,{...item,status:'ready',instagram_media_id:undefined,caption_policy:undefined},null,
    `throw new Error('Unverified caption must not reach either platform');`,0,
    {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()});
  assert.equal(r.report.threads_steps,0); assert.equal(r.item.threads_container_id,undefined);
});
test('bad caption in-flight Threads item cannot block validated ready video', t => {
  const r=run(t,{...item,status:'ready',instagram_media_id:undefined},null,
    `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('Instagram must remain held'); return new Response(JSON.stringify({id:'new-threads-container'}));`,0,
    {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()},50,100,
    [{...item,id:'old',status:'ready',instagram_media_id:undefined,threads_container_id:'bad-caption-container',caption_policy:undefined}]);
  assert.equal(r.item.threads_container_id,'new-threads-container');
  assert.equal(r.report.threads_steps,1);
});
test('authorized recovery really publishes one feed above internal cap but below platform ceiling', t => {
  const r=run(t,{...item,status:'ready',instagram_media_id:undefined,instagram_container_id:'recovery-container',threads_media_id:'thread',threads_status:'published'},null,
    `if(options.method==='POST') return new Response(JSON.stringify({id:'recovery-live'})); if(String(url).includes('/recovery-container?')) return new Response(JSON.stringify({status_code:'FINISHED'})); return new Response(JSON.stringify({id:'recovery-live',permalink:'https://www.instagram.com/p/recovered/'}));`,0,
    {usage:43,total:100,effective_total:50,blocked:false,checked_at:new Date().toISOString(),next_check_at:new Date(Date.now()+900000).toISOString()},43,100,[],
    {mode:'one-feed-and-story',item_id:'test',authorized_at:new Date(Date.now()-60000).toISOString(),expires_at:new Date(Date.now()+1800000).toISOString()});
  assert.equal(r.item.instagram_media_id,'recovery-live');
  assert.equal(r.report.publications.length,1);
});
test('dedicated Story preview is uploaded without replacing the full Reel', t => {
  const r=run(t,{...item,story_video:'media/story-preview.mp4',threads_status:'published',threads_media_id:'thread'},null,
    `if(options.method==='POST') { if(!String(options.body.get('video_url')).endsWith('/media/story-preview.mp4')) throw new Error('Expected dedicated Story preview'); return new Response(JSON.stringify({id:'story-container'})); } throw new Error('No immediate polling expected');`);
  assert.equal(r.item.instagram_story_container_id,'story-container');
  assert.equal(r.item.video,'media/test.mp4');
});

function photoRecord(count=1) {
 const copy=vipCaption('',item.source_handle,item.source_url);
 return {...item,...copy,rendered_body_text:copy.body,status:'ready',instagram_media_id:undefined,
   content_type:count===1?'image':'carousel',type:'source_media_repost',vip_repost:true,
   caption_policy:'vip-source-v1',source_caption_text:'',vip_source_checked:true,
   layout_template:'rapwire-source-media-v1',visual_asset_rights:'source_post_repost',
   media_capture_complete:true,source_item_count:count,
   media_items:Array.from({length:count},(_,i)=>({type:i===1?'video':'image',path:`media/test-${i}.${i===1?'mp4':'jpg'}`,source_index:i})),
   story:'media/test-story.jpg'};
}
test('VIP photo creates a single Threads image even while Instagram is held',t=>{
 const r=run(t,photoRecord(),null,
   `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('IG held'); if(options.body.get('media_type')!=='IMAGE'||!options.body.get('image_url')||options.body.has('is_carousel_item')) throw new Error('Expected single image'); return new Response(JSON.stringify({id:'photo-container'}));`,0,
   {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()});
 assert.equal(r.item.threads_container_id,'photo-container');assert.equal(r.item.status,'ready');
});
test('mixed VIP carousel uploads each child with the right type and retains IDs',t=>{
 const r=run(t,photoRecord(2),null,
  `if(!String(url).startsWith('https://graph.threads.net/')) throw new Error('IG held'); if(options.body.get('is_carousel_item')!=='true') throw new Error('Must create children first'); const type=options.body.get('media_type'); if(type==='VIDEO'&&!options.body.get('video_url')) throw new Error('Missing video'); return new Response(JSON.stringify({id:type}));`,0,
  {usage:50,total:100,blocked:true,next_check_at:new Date(Date.now()+3600000).toISOString()});
 assert.deepEqual(r.item.threads_children.map(c=>c.id),['IMAGE','VIDEO']);assert.equal(r.item.threads_container_id,undefined);
});
test('incomplete VIP carousel cannot reach either platform',t=>{
 const r=run(t,{...photoRecord(2),source_item_count:3},null,`throw new Error('Incomplete media cannot publish');`);
 assert.equal(r.report.instagram_steps,0);assert.equal(r.report.threads_steps,0);
});
test('Instagram photo parent resumes and records a confirmed publication',t=>{
 const r=run(t,{...photoRecord(),instagram_container_id:'photo-container',threads_status:'published',threads_media_id:'thread'},null,
 `if(options.method==='POST') return new Response(JSON.stringify({id:'photo-live'})); if(String(url).includes('/photo-container?')) return new Response(JSON.stringify({status_code:'FINISHED'})); return new Response(JSON.stringify({id:'photo-live',permalink:'https://www.instagram.com/p/photo-live/'}));`);
 assert.equal(r.item.instagram_media_id,'photo-live');assert.equal(r.item.status,'published');assert.equal(r.item.instagram_permalink,'https://www.instagram.com/p/photo-live/');
});
