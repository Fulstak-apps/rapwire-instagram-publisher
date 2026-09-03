import test from 'node:test';
import assert from 'node:assert/strict';
import {isVip, rememberVip, vipCandidates, deferVip, vipCaption} from './vip-policy.mjs';
import {captionIsBound, sourceCaption} from './video-caption.mjs';
const sources = [{handle:'akademiks'}, {handle:'traploreross'}];
const discovered = Array.from({length:12}, (_,i)=>({source:sources[i%2],url:`https://www.instagram.com/p/post${i}/`,shortcode:`post${i}`,profilePosition:i}));
test('only the two requested VIP pages bypass editorial selection',()=>{
  assert.equal(isVip('@Akademiks'),true);
  assert.equal(isVip('traploreross'),true);
  assert.equal(isVip('saycheesetv'),false);
});
test('all discovered VIP posts survive, not just the first four or videos',()=>{
  const ledger={queued_shortcodes:{}};
  rememberVip(ledger,discovered,1000);
  assert.equal(vipCandidates(ledger,sources,1000).length,12);
  rememberVip(ledger,[],2000);
  assert.equal(vipCandidates(ledger,sources,2000).length,12);
});
test('reposted items dedupe while old unseen history is not imported',()=>{
  const ledger={queued_shortcodes:{post0:{}},seen_shortcodes:{old:{source_handle:'akademiks'}}};
  rememberVip(ledger,discovered,1000);
  assert.equal(vipCandidates(ledger,sources,1000).length,11);
  assert.equal(ledger.vip_pending.old,undefined);
});
test('failed downloads remain pending and retry without blocking untried posts',()=>{
  const ledger={queued_shortcodes:{}};
  rememberVip(ledger,discovered,1000);
  deferVip(ledger,discovered[0],new Error('capture unavailable'),1000);
  assert.equal(ledger.vip_pending.post0.state,'retry_pending');
  assert.equal(vipCandidates(ledger,sources,1001).length,11);
  assert.equal(vipCandidates(ledger,sources,200000).length,12);
  assert.notEqual(vipCandidates(ledger,sources,200000)[0].shortcode,'post0');
});
test('VIP caption does not reject AI, opinions, short or missing captions',()=>{
  const url=discovered[0].url;
  for(const raw of ['AI','🔥','', 'My opinion about a trial.', 'x'.repeat(2500)]) {
    const fields=vipCaption(raw,'akademiks',url);
    assert.ok(fields.caption.length < 2200);
    assert.ok(fields.threads_text.length < 400);
  assert.doesNotMatch(fields.caption,/@akademiks/);
    assert.equal(captionIsBound({...fields,rendered_body_text:fields.body,source_handle:'akademiks',source_url:url,
      caption_policy:'vip-source-v1',caption_source_shortcode:'post0',source_caption_text:raw,vip_source_checked:true}),true);
  }
});
test('VIP attribution never allows mismatched media or tampered body',()=>{
  const fields=vipCaption('AI','akademiks',discovered[0].url);
  const record={...fields,rendered_body_text:fields.body,source_handle:'akademiks',source_url:discovered[0].url,
    caption_policy:'vip-source-v1',caption_source_shortcode:'post0',source_caption_text:'AI',vip_source_checked:true};
  assert.equal(captionIsBound({...record,source_handle:'nojumper'}),false);
  assert.equal(captionIsBound({...record,caption_source_shortcode:'wrong'}),false);
  assert.equal(captionIsBound({...record,body:'Invented headline'}),false);
});
test('sparse source metadata is allowed only with the exact canonical post',()=>{
  const data={requestedUrl:discovered[0].url,canonicalUrl:discovered[0].url,title:'Akademiks on Instagram: "AI"',allowSparse:true};
  assert.equal(sourceCaption(data),'AI');
  assert.throws(()=>sourceCaption({...data,canonicalUrl:discovered[1].url}),/match/);
  assert.equal(sourceCaption({...data,title:'Akademiks on Instagram: "A truncated caption…"'}),'');
});
