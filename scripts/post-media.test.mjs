import test from 'node:test';
import assert from 'node:assert/strict';
import {walkPost} from './post-media.mjs';
import {validMediaRepost} from './repost-media-policy.mjs';
import {vipCaption} from './vip-policy.mjs';

test('capture preserves image/video order until the final slide',async()=>{
 let position=0;
 const source=[{src:'a',type:'image'},{src:'b',type:'video'},{src:'c',type:'image'}];
 const result=await walkPost({read:async()=>source[position],saveItem:async m=>m,next:async()=>position<source.length-1,advance:async()=>position++});
 assert.deepEqual(result,source);
});
test('failed middle slide never returns a complete capture',async()=>{
 let position=0;
 await assert.rejects(walkPost({read:async()=>({src:String(position)}),saveItem:async m=>{if(position===1)throw new Error('download failed');return m;},next:async()=>true,advance:async()=>position++}),/download failed/);
});
test('a carousel that did not advance stays pending',async()=>{
 await assert.rejects(walkPost({read:async()=>({src:'same'}),saveItem:async m=>m,next:async()=>true,advance:async()=>{}}),/did not advance/);
});
test('capture never silently truncates at its item bound',async()=>{
 let position=0;
 await assert.rejects(walkPost({read:async()=>({src:String(position)}),saveItem:async m=>m,next:async()=>true,advance:async()=>position++,maxItems:2}),/exceeds capture bound/);
});
const source_url='https://www.instagram.com/p/Exact/';
const copy=vipCaption('', 'akademiks', source_url);
const photo={...copy,rendered_body_text:copy.body,source_url,source_handle:'akademiks',caption_policy:'vip-source-v1',caption_source_shortcode:'Exact',vip_source_checked:true,
 type:'source_media_repost',vip_repost:true,layout_template:'rapwire-source-media-v1',visual_asset_rights:'source_post_repost',media_capture_complete:true,source_item_count:1,content_type:'image',media_items:[{type:'image',path:'media/a.jpg',source_index:0}]};
test('one complete VIP photo is publishable without fake duplicate slides',()=>assert.equal(validMediaRepost(photo),true));
test('partial, reordered, non-VIP and duplicate asset manifests are rejected',()=>{
 for(const patch of [{source_item_count:2},{media_capture_complete:false},{source_handle:'someone_else'},{media_items:[{type:'image',path:'media/a.jpg',source_index:1}]},{source_item_count:2,content_type:'carousel',media_items:[{type:'image',path:'media/a.jpg',source_index:0},{type:'image',path:'media/a.jpg',source_index:1}]}]) assert.equal(validMediaRepost({...photo,...patch}),false);
});
