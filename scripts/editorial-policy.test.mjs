import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanPublicCopy,reportingGate,claimHash,storyFingerprint,editorialRank,selectionAllowed} from './editorial-policy.mjs';
import {dueSources,normalizeSources} from './source-policy.mjs';
import {composeThreads,discussionPrompt,selectReply,editorialSeries} from './audience-policy.mjs';
const now=Date.parse('2026-09-03T07:00:00Z');
test('remove legacy source headers without dropping the artist mention',()=>{
 assert.equal(cleanPublicCopy('@traploreross Source commentary: Lil Durk (@lildurk) discussed his album.','traploreross'),'Lil Durk (@lildurk) discussed his album.');
});
test('case outcomes require independent, recent evidence tied to the actual copy',()=>{
 const item={body:'Duane Davis was found guilty of murder.'};
 assert.equal(reportingGate(item,now).allowed,false);
 item.news_verification={status:'verified',claim_sha256:claimHash(item.body),checked_at:new Date(now).toISOString(),notes:'Two independent reports support the verdict and identify the exact verdict date.',sources:[
  {publisher:'AP',url:'https://apnews.com/article/test',independent:true,supports:'Verdict'},
  {publisher:'Reuters',url:'https://reuters.com/world/test',independent:true,supports:'Verdict'}]};
 assert.equal(reportingGate(item,now).allowed,true);
 item.body+=' He was sentenced today.';assert.equal(reportingGate(item,now).allowed,false);
});
test('syndicated same-publisher reports do not count as two sources',()=>{
 const body='A rapper was sentenced to prison.';
 const v={status:'verified',claim_sha256:claimHash(body),checked_at:new Date(now).toISOString(),notes:'Checked the reporting against the same syndicated news report.',sources:[1,2].map(x=>({publisher:'Reuters',url:'https://example.com/'+x,independent:true,supports:'Sentence'}))};
 assert.equal(reportingGate({body,news_verification:v},now).allowed,false);
 assert.equal(reportingGate({body:'Drake performs a freestyle.'},now).allowed,true);
});
test('same caption on two source pages fingerprints identically',()=>{
 assert.equal(storyFingerprint('Drake performed a new freestyle at the festival last night. @one'),storyFingerprint('Drake performed a new freestyle at the festival last night. @two'));
 assert.equal(storyFingerprint('New music'),null);
});
test('source streaks make room for a different source without losing the VIP queue',()=>{
 const recent=[{source_handle:'records',body:'A rap song.'},{source_handle:'records',body:'Another rap song.'}];
 assert.ok(editorialRank({source_handle:'xxl',publish_priority:50},recent)>editorialRank({source_handle:'records',publish_priority:100},recent));
 assert.equal(selectionAllowed({source:{scope:'gaming'},visibleCaption:'Grand Theft Auto gameplay arrives.'},[{body:'New GTA 6 trailer.'}]),false);
});
test('poll only a bounded rotating normal-source window and honor retries',()=>{
 const sources=normalizeSources({sources:['akademiks','xxl','hiphopdx','complexmusic'].map(handle=>({handle,scope:'hiphop',enabled:true,approved_by:'user'}))});
 assert.equal(dueSources(sources,{},now).length,3);
 assert.equal(dueSources(sources,{source_checks:Object.fromEntries(sources.map(x=>[x.handle,{checked_at:new Date(now).toISOString()}]))},now).length,0);
});
test('court/tragedy context never gets a top-five question',()=>{
 assert.doesNotMatch(discussionPrompt('Drake appeared in court after being charged.'),/top 5|overrated/);
 assert.equal(discussionPrompt('Kendrick mourns a friend who died.'),'');
 assert.equal(selectReply('Jay-Z is a top five rapper.','My refrigerator delivery arrives tomorrow.'),null);
});
test('recurring formats follow the actual post context',()=>{
 assert.equal(editorialSeries('The jury returned a guilty verdict.'),'Case File');
 assert.equal(editorialSeries('The new album is out now.'),'New Music Watch');
 assert.equal(editorialSeries('A classic verse from the archive.'),'From the Vault');
 assert.equal(editorialSeries('Jay-Z is top five. Who are you moving out?'),'RapWire Debate');
});
test('rap culture Threads copy opens a specific conversation',()=>{
 const text=composeThreads('A Detroit rap artist brought a new sound to the culture.',{seed:'detroit'});
 assert.match(text,/What is the first artist|Does this add|What context would change|replay value|strongest argument/);
 assert.doesNotMatch(text,/thoughts\?/i);
});
test('music debate prompts can be deliberately provocative without targeting a sensitive event',()=>{
 const prompt=discussionPrompt('Drake released a new song.', 'provocative');
 assert.match(prompt,/replay value|catalog|rollout hype/i);
 assert.equal(discussionPrompt('A rapper died after a shooting.', 'provocative'),'');
});
test('Threads budgets include question and footer and preserve complete copy',()=>{
 const text=composeThreads(('Drake performed his new single on tour. ').repeat(30));
 assert.ok([...text].length<=500);assert.ok(text.endsWith('@rapwire247'));
 assert.equal(composeThreads('a'.repeat(600)),'');
});
