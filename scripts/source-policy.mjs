import {isVip} from './vip-policy.mjs';
export function normalizeSources(config) {
  const seen=new Set();
  return config.sources.filter(x=>x.enabled).map(x=>{
    if(!/^[a-z0-9_.]{1,30}$/.test(x.handle)||seen.has(x.handle)||!['hiphop','gaming'].includes(x.scope)
      || (!x.identity_source&&x.approved_by!=='user')) throw new Error('Invalid or unverified source configuration');
    const dailyMinimum=Number(x.daily_minimum||0);
    if(!Number.isInteger(dailyMinimum)||dailyMinimum<0||dailyMinimum>4) throw new Error('Invalid daily source minimum');
    seen.add(x.handle);return {...x,daily_minimum:dailyMinimum,fastTrack:x.fast_track===true,includePosts:x.include_posts!==false,includeReels:x.include_reels!==false};
  });
}
export function dueSources(sources,ledger,now=Date.now()) {
  const history=ledger.source_checks||{};
  const due=sources.filter(x=>!(Date.parse(history[x.handle]?.retry_at||'')>now)
    && now-(Date.parse(history[x.handle]?.checked_at||'')||0)>=(isVip(x.handle)?5:x.fastTrack?10:30)*60000)
    .sort((a,b)=>(Date.parse(history[a.handle]?.checked_at||'')||0)-(Date.parse(history[b.handle]?.checked_at||'')||0));
  return [...due.filter(x=>isVip(x.handle)),...due.filter(x=>!isVip(x.handle)).slice(0,2)];
}

function detroitDay(value) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Detroit',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const get=type=>parts.find(x=>x.type===type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Count both delivered and already-queued posts. A source with a daily minimum
// is selected until its two slots are reserved, but never flooded with retries.
export function dailySourceDeficits(sources, records, now=Date.now()) {
  const today=detroitDay(now);
  return sources.filter(source=>source.daily_minimum>0).map(source=>{
    const scheduled=records.filter(item=>String(item.source_handle||'').toLowerCase()===source.handle
      && item.status!=='failed'
      && (detroitDay(item.instagram_published_at||item.published_at||'')===today || item.date===today)).length;
    return {source,scheduled,remaining:Math.max(0,source.daily_minimum-scheduled)};
  }).filter(entry=>entry.remaining>0);
}
