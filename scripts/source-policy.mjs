import {isVip} from './vip-policy.mjs';
export function normalizeSources(config) {
  const seen=new Set();
  return config.sources.filter(x=>x.enabled).map(x=>{
    if(!/^[a-z0-9_.]{1,30}$/.test(x.handle)||seen.has(x.handle)||!['hiphop','gaming'].includes(x.scope)
      || (!x.identity_source&&x.approved_by!=='user')) throw new Error('Invalid or unverified source configuration');
    seen.add(x.handle);return {...x,includePosts:true,includeReels:true};
  });
}
export function dueSources(sources,ledger,now=Date.now()) {
  const history=ledger.source_checks||{};
  const due=sources.filter(x=>!(Date.parse(history[x.handle]?.retry_at||'')>now)
    && now-(Date.parse(history[x.handle]?.checked_at||'')||0)>=(isVip(x.handle)?5:30)*60000)
    .sort((a,b)=>(Date.parse(history[a.handle]?.checked_at||'')||0)-(Date.parse(history[b.handle]?.checked_at||'')||0));
  return [...due.filter(x=>isVip(x.handle)),...due.filter(x=>!isVip(x.handle)).slice(0,2)];
}
