import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validVideoLayout,videoLayoutGate,verifyVideoLayoutFiles,videoRepairAllowed,capturedVideoLayout,capturedMediaItems,mixedVideoLayoutReview} from './video-layout-policy.mjs';

const bytes=Buffer.from('validated test output');
const digest=value=>createHash('sha256').update(value).digest('hex');
const layout={version:'footage-only-v1',status:'validated',source_width:1080,source_height:1920,
  crop:{x:0,y:320,width:1080,height:1400},output_width:1080,output_height:1350,
  caption_overlay:false,logo_position:'bottom-left',source_sha256:digest('source stream'),output_sha256:digest(bytes),
  analysis:{sample_times:[0,1,2],removed_regions:['source_header'],preserved_in_footage_text:true}};
const item={id:'render',status:'ready',content_type:'video',video:'media/render.mp4',video_layout:layout};

test('validated footage-only evidence accepts a crop or a proven no-panel full frame',()=>{
  assert.equal(validVideoLayout(layout),true);
  assert.equal(validVideoLayout({...layout,crop:{x:0,y:0,width:1080,height:1920}}),true);
});

test('layout policy fails closed on missing proof, invalid crop geometry, overlays or hashes',()=>{
  for(const value of [undefined,{}, {...layout,version:'legacy'}, {...layout,status:'needs_review'},
    {...layout,source_width:0}, {...layout,source_height:NaN},
    {...layout,crop:{x:-2,y:0,width:100,height:100}}, {...layout,crop:{x:0,y:1000,width:1080,height:1000}},
    {...layout,crop:{x:0,y:0,width:Infinity,height:100}}, {...layout,crop:{x:.5,y:0,width:100,height:100}},
    {...layout,crop:{x:1,y:0,width:100,height:100}}, {...layout,crop:{x:0,y:0,width:101,height:100}},
    {...layout,output_height:1920}, {...layout,caption_overlay:true}, {...layout,logo_position:'top-right'},
    {...layout,source_sha256:''}, {...layout,output_sha256:'not-a-sha256'}])assert.equal(validVideoLayout(value),false);
});

test('capture provenance survives single-video and per-carousel-item copies without mutation',()=>{
  const original=structuredClone(layout);
  const root=capturedVideoLayout({video_layout:layout});
  assert.deepEqual(root,original);
  root.analysis.sample_times.push(3);
  assert.deepEqual(layout,original);
  const media=capturedMediaItems({items:[{type:'image'},{type:'video',video_layout:layout}]},['media/photo.jpg','media/clip.mp4']);
  assert.deepEqual(media,[{type:'image',path:'media/photo.jpg',source_index:0},{type:'video',path:'media/clip.mp4',source_index:1,video_layout:layout}]);
  assert.deepEqual(capturedVideoLayout(media[1]),layout);
  assert.throws(()=>capturedMediaItems({items:[{type:'video'}]},['media/clip.mp4']),/lacks validated/);
});

test('every video in a mixed carousel needs independent crop proof while still photos are unaffected',()=>{
  assert.equal(videoLayoutGate({content_type:'image',media_items:[{type:'image',path:'media/a.jpg'}]}).allowed,true);
  const carousel={content_type:'carousel',media_items:[{type:'image',path:'media/a.jpg'},{type:'video',path:'media/b.mp4',video_layout:layout}]};
  assert.equal(videoLayoutGate(carousel).allowed,true);
  delete carousel.media_items[1].video_layout;
  assert.equal(videoLayoutGate(carousel).allowed,false);
  assert.match(videoLayoutGate(carousel).issues[0],/media_items\[1\]/);
});

test('remote video overrides cannot bypass the proven local render',()=>{
  assert.equal(videoLayoutGate({...item,video_url:'https://example.invalid/original.mp4'}).allowed,false);
  assert.match(videoLayoutGate({...item,video_url:'https://example.invalid/original.mp4'}).issues.join(' '),/not bound/);
});

test('output hash is verified against actual files, not only trusted from metadata',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rapwire-layout-policy-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'media'));
  await fs.writeFile(path.join(dir,item.video),bytes);
  assert.equal((await verifyVideoLayoutFiles(item,dir)).allowed,true);
  await fs.writeFile(path.join(dir,item.video),'different video bytes');
  const changed=await verifyVideoLayoutFiles(item,dir);
  assert.equal(changed.allowed,false);assert.match(changed.issues[0],/no longer match/);
  assert.equal((await verifyVideoLayoutFiles({...item,video:'media/missing.mp4'},dir)).allowed,false);
  assert.equal((await verifyVideoLayoutFiles({...item,video:'../outside.mp4'},dir)).allowed,false);
});

test('repair is limited to never-started standalone videos across every publication marker',()=>{
  assert.equal(videoRepairAllowed(item),true);
  assert.equal(videoRepairAllowed({...item,status:'published'}),false);
  assert.equal(videoRepairAllowed({...item,content_type:'carousel'}),false);
  for(const prefix of ['instagram','threads','instagram_story']) {
    for(const [suffix,value] of [['media_id','live'],['container_id','container'],['children',[{id:'child'}]],
      ['publish_requested_at','2026-09-03T05:00:00Z'],['reconcile_required',true],['status','published']]) {
      assert.equal(videoRepairAllowed({...item,[`${prefix}_${suffix}`]:value}),false,`${prefix}_${suffix}`);
    }
  }
  assert.equal(videoRepairAllowed({...item,threads_children:[]}),true);
});

test('unproven mixed backlog gets an actionable, nonmutating hold instead of blind image substitution',()=>{
  const carousel={id:'mixed',status:'ready',type:'source_media_repost',content_type:'carousel',source_url:'https://www.instagram.com/p/exact/',
    caption:'Keep original written caption',media_items:[{type:'image',path:'media/a.jpg',source_index:0},{type:'video',path:'media/b.mp4',source_index:1}]};
  const original=structuredClone(carousel);
  const review=mixedVideoLayoutReview(carousel);
  assert.equal(review.status,'review_required');assert.equal(review.source_url,carousel.source_url);
  assert.deepEqual(review.video_indices,[1]);assert.match(review.reason,/verify every image\/video against the saved order/);
  assert.deepEqual(carousel,original);
  for(const patch of [{threads_media_id:'live'},{instagram_container_id:'pending'},{threads_publish_requested_at:'uncertain'}]) {
    assert.equal(mixedVideoLayoutReview({...carousel,...patch}),null);
  }
  assert.equal(mixedVideoLayoutReview(carousel,{allowed:true,issues:[]}),null);
});
