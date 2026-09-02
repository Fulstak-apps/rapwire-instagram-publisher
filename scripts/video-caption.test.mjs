import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCaption, buildVideoCaption, captionIsBound } from './video-caption.mjs';
const url = 'https://www.instagram.com/akademiks/reel/abc123/';
test('extracts only exact-post caption, not profile wrapper', () => {
  assert.equal(sourceCaption({ requestedUrl:url,canonicalUrl:url,title:'Akademiks on Instagram: "Lil Durk discusses his new album."' }), 'Lil Durk discusses his new album.');
  assert.throws(()=>sourceCaption({ requestedUrl:url,canonicalUrl:url.replace('abc123','other'), title:'Akademiks on Instagram: "Lil Durk discusses his new album."' }), /match/);
});
test('generic and truncated captions are rejected, never padded', () => {
  assert.throws(()=>buildVideoCaption('A new hip-hop video is moving through the feed.', 'akademiks'), /specific/);
  assert.throws(()=>sourceCaption({requestedUrl:url,canonicalUrl:url,title:'Page on Instagram: "This sentence was cut off…"'}), /truncated/);
});
test('only explicitly verified people get handles', () => {
  const result = buildVideoCaption('Lil Durk discusses his new album with fans.', 'akademiks', [{name:'Lil Durk',handle:'lildurk',verified_at:new Date().toISOString(),verified_url:'https://www.instagram.com/lildurk/'}]);
  assert.match(result.body,/Lil Durk \(@lildurk\)/);
  assert.equal(result.caption.endsWith('@Rapwire247\n@akademiks'), true);
  assert.doesNotMatch(buildVideoCaption('New footage shared by @someblog shows a recording session.', 'akademiks').body, /@someblog/);
});
test('caption evidence must use same shortcode', () => {
  const record = {caption_policy:'exact-source-v1',caption_source_shortcode:'other',source_url:url,source_caption_text:'A complete description of a studio recording.',body:'A complete description of a studio recording.'};
  assert.equal(captionIsBound(record),false);
});
test('accusatory source commentary is attributed instead of presented as a verdict', () => {
  const result = buildVideoCaption('OTF Vonni caught in MULTIPLE LIES. Their stories did not add up.', 'traploreross');
  assert.match(result.body,/^Source commentary:/);
  assert.match(result.body,/source claims, not findings of guilt/);
});
