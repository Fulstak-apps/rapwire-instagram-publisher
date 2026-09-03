import {createHash} from 'node:crypto';
import {editorialTopic} from './audience-policy.mjs';

export function cleanPublicCopy(value, source='') {
  const handle=String(source).replace(/^@/,'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  let text=String(value||'').trim();
  for(let i=0;i<3;i++) text=text.replace(/^Source commentary:\s*/i,'')
    .replace(/^Reposted from @[A-Za-z0-9_.]+\.\s*/i,'')
    .replace(handle?new RegExp('^@'+handle+'(?=[\\s:—–-]|$)[\\s:—–-]*','i'):/$^/,'').trim();
  return text;
}
export const claimHash = text => createHash('sha256').update(String(text||'').trim()).digest('hex');
export function needsReporting(item) {
  const text=String(item.body||'');
  const reasons=[];
  if(/\b(?:found (?:not )?guilty|convict(?:ed|ion)|sentenced to|acquitt(?:ed|al)|charged with|arrested for|has died|was killed|dead at|died at)\b/i.test(text)) reasons.push('major_case_or_death_claim');
  if(/\bI (?:spent .{0,30}investigating|interviewed|witnessed|obtained|confirmed|recovered .{0,30}deleted)\b/i.test(text)) reasons.push('first_person_reporting_claim');
  return reasons;
}
export function reportingGate(item, now=Date.now()) {
  const reasons=needsReporting(item);
  if(!reasons.length) return {allowed:true,reasons:[]};
  const v=item.news_verification;
  const publishers=new Set();
  for(const source of v?.sources||[]) {
    try {
      const url=new URL(source.url);
      if(url.protocol==='https:' && source.publisher && source.supports && source.independent===true)
        publishers.add(source.publisher.toLowerCase().trim());
    } catch {}
  }
  const checked=Date.parse(v?.checked_at||'');
  const allowed=v?.status==='verified' && v.claim_sha256===claimHash(item.body)
    && publishers.size>=2 && checked<=now && now-checked<72*3600000
    && typeof v.notes==='string' && v.notes.trim().length>=30;
  return {allowed,reasons:allowed?[]:reasons};
}
export function storyFingerprint(text) {
  const words=String(text||'').toLowerCase().replace(/https?:\/\/\S+|@[\w.]+|#[\w]+/g,'')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/);
  return words.length>=8?claimHash(words.join(' ')):null;
}
export function contentLane(item) {
  const topic=editorialTopic(item.body||item.visibleCaption||'');
  return topic==='gaming'?'gaming':topic==='court'?'court':topic==='music'?'music':'culture';
}
export function recentPosts(records) {
  const latest=item=>Math.max(...['instagram_published_at','published_at','threads_published_at'].map(key=>Date.parse(item[key]||'')||0));
  return records.filter(x=>x.instagram_media_id||x.threads_media_id)
    .sort((a,b)=>latest(b)-latest(a));
}
export function editorialRank(item, recent=[]) {
  let score=Number(item.publish_priority||50);
  const lane=contentLane(item);
  if(recent.slice(0,2).length===2 && recent.slice(0,2).every(x=>x.source_handle===item.source_handle)) score-=120;
  if(recent.slice(0,3).length===3 && recent.slice(0,3).every(x=>contentLane(x)===lane)) score-=65;
  if(lane==='gaming'&&recent.slice(0,6).some(x=>contentLane(x)==='gaming')) score-=500;
  return score;
}
export function selectionAllowed(candidate, recent=[]) {
  const body=candidate.visibleCaption||'';
  const lane=contentLane({body});
  if(lane==='gaming'&&recent.slice(0,6).some(x=>contentLane(x)==='gaming')) return false;
  if(candidate.source.scope==='gaming'&&lane!=='gaming') return false;
  if(candidate.source.scope==='hiphop' && !/\b(?:hip[- ]?hop|rap(?:per)?|mixtape|freestyle|drake|kendrick|durk|cole|tupac|youngboy|young thug|jay[- ]?z|nicki|cardi|doechii|travis scott|21 savage|future|lil wayne)\b/i.test(body)) return false;
  const fingerprint=storyFingerprint(body);
  return !fingerprint || !recent.some(item=>storyFingerprint(item.body)===fingerprint);
}
