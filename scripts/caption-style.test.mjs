import test from 'node:test';
import assert from 'node:assert/strict';
import {signedCaption,refreshCaptionStyle} from './caption-style.mjs';
import {captionIsBound} from './video-caption.mjs';

test('new style has source tag, news and only the account handle as footer',()=>{
 const item={source_handle:'akademiks'};
 const result=signedCaption('Reposted from @akademiks.\n\nNew album announced.\n\nRap Wire 24/7\n@Rapwire247\n@akademiks',item);
 assert.equal(result,'New album announced.\n\n@rapwire247');
 const owned = signedCaption('Clip from the archive.', {source_handle:'records'});
 assert.doesNotMatch(owned, /@records\b/i);
 assert.equal(signedCaption(result,item),result);
});
test('queue migration rebuilds only safely unpublished parent containers',()=>{
 const item={status:'ready',source_handle:'akademiks',source_url:'https://www.instagram.com/p/abc/',source_caption_text:'New album announced.',caption_source_shortcode:'abc',caption_policy:'vip-source-v1',vip_source_checked:true,
  body:'New album announced.',rendered_body_text:'New album announced.',caption:'old caption',threads_text:'old caption',instagram_container_id:'old-ig',instagram_children:[{id:'child'}],threads_container_id:'uncertain-thread',threads_publish_requested_at:'2026-09-02T00:00:00Z'};
 assert.equal(refreshCaptionStyle(item),true);
 assert.equal(item.caption,'New album announced.\n\nBe real—y’all feeling this one?\n\n@rapwire247');
 assert.equal(item.instagram_container_id,undefined);
 assert.deepEqual(item.instagram_children,[{id:'child'}]);
 assert.equal(item.threads_container_id,'uncertain-thread');
 assert.equal(item.threads_text,'old caption');
 assert.equal(captionIsBound(item),true);
 assert.equal(refreshCaptionStyle(item),false);
});
test('artist migration preserves published Threads copy and fits pending Threads copy',()=>{
 const registry=[{name:'Drake',handle:'champagnepapi',verified_at:new Date().toISOString(),verified_url:'https://www.instagram.com/champagnepapi/'}];
 const caption='Drake announced a new date. '+('Fans are discussing the upcoming show. '.repeat(18));
 const published={status:'published',caption,body:caption,threads_text:'Already published.',threads_media_id:'existing'};
 refreshCaptionStyle(published,registry);
 assert.equal(published.threads_text,'Already published.');
 const pending={status:'ready',caption,body:caption,threads_text:'Drake announced a new date.',threads_copy_policy:'discussion-v2'};
 refreshCaptionStyle(pending,registry);
 assert.ok(pending.threads_text.length<=500);
 assert.match(pending.threads_text,/@champagnepapi/);
});
test('fully published posts keep their recorded captions',()=>{
 const item={status:'published',instagram_media_id:'ig',threads_media_id:'threads',caption:'historical'};
 assert.equal(refreshCaptionStyle(item),false);assert.equal(item.caption,'historical');
});
test('unpublished artist copy gains only a verified artist handle',()=>{
 const item={status:'ready',source_handle:'akademiks',caption_style:'source-tag-v1',body:'Drake announced a new date.',caption:'Drake announced a new date.\n\n@rapwire247',threads_text:'Drake announced a new date.\n\n@rapwire247'};
 const registry=[{name:'Drake',handle:'champagnepapi',verified_at:new Date().toISOString(),verified_url:'https://www.instagram.com/champagnepapi/'}];
 assert.equal(refreshCaptionStyle(item,registry),true);
 assert.match(item.caption,/Drake @champagnepapi/);
 assert.deepEqual(item.artist_handles,['champagnepapi']);
});
