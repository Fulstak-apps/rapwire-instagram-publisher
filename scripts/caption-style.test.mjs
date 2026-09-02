import test from 'node:test';
import assert from 'node:assert/strict';
import {signedCaption,refreshCaptionStyle} from './caption-style.mjs';
import {captionIsBound} from './video-caption.mjs';

test('new style has source tag, news and only the account handle as footer',()=>{
 const item={source_handle:'akademiks'};
 const result=signedCaption('Reposted from @akademiks.\n\nNew album announced.\n\nRap Wire 24/7\n@Rapwire247\n@akademiks',item);
 assert.equal(result,'@akademiks\n\nNew album announced.\n\n@rapwire247');
 assert.equal(signedCaption(result,item),result);
});
test('queue migration rebuilds only safely unpublished parent containers',()=>{
 const item={status:'ready',source_handle:'akademiks',source_url:'https://www.instagram.com/p/abc/',source_caption_text:'New album announced.',caption_source_shortcode:'abc',caption_policy:'vip-source-v1',vip_source_checked:true,
 body:'Reposted from @akademiks.\n\nNew album announced.',rendered_body_text:'Reposted from @akademiks.\n\nNew album announced.',caption:'old caption',threads_text:'old caption',instagram_container_id:'old-ig',instagram_children:[{id:'child'}],threads_container_id:'uncertain-thread',threads_publish_requested_at:'2026-09-02T00:00:00Z'};
 assert.equal(refreshCaptionStyle(item),true);
 assert.equal(item.caption,'@akademiks\n\nNew album announced.\n\n@rapwire247');
 assert.equal(item.instagram_container_id,undefined);
 assert.deepEqual(item.instagram_children,[{id:'child'}]);
 assert.equal(item.threads_container_id,'uncertain-thread');
 assert.equal(captionIsBound(item),true);
 assert.equal(refreshCaptionStyle(item),false);
});
test('fully published posts keep their recorded captions',()=>{
 const item={status:'published',instagram_media_id:'ig',threads_media_id:'threads',caption:'historical'};
 assert.equal(refreshCaptionStyle(item),false);assert.equal(item.caption,'historical');
});
