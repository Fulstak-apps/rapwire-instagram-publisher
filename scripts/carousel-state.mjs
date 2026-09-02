import {advanceContainer} from './container-state.mjs';

// Child upload IDs survive interruptions. Parent publication uses the same
// durable pre-publish marker as Reels so a timeout cannot duplicate a feed post.
export async function advanceMediaPost({item,prefix,media,createChild,createParent,createSingle,inspect,publish,save,now=Date.now()}) {
  if(item[`${prefix}_media_id`] || item[`${prefix}_container_id`] || item[`${prefix}_reconcile_required`]) {
    return advanceContainer({item,prefix,create:()=>{throw new Error('Unexpected parent recreation');},inspect,publish,save,now});
  }
  if(Date.parse(item[`${prefix}_retry_at`]||'')>now) return null;
  if(media.length===1) return advanceContainer({item,prefix,create:()=>createSingle(media[0]),inspect,publish,save,now});
  const key=`${prefix}_children`;
  item[key] ||= [];
  for(let index=0;index<media.length;index++) {
    let child=item[key][index];
    if(!child) {
      const result=await createChild(media[index],index);
      if(!result?.id) throw new Error('Child upload response missing ID');
      child={id:result.id,checked_at:new Date(now).toISOString(),status:'IN_PROGRESS'};
      item[key][index]=child;
      await save();
      continue;
    }
    if(now-Date.parse(child.checked_at||'')<120000) continue;
    const result=await inspect(child.id);
    child.status=result.status_code||result.status;
    child.checked_at=new Date(now).toISOString();
    if(['ERROR','EXPIRED'].includes(child.status)) {
      item[`${prefix}_retry_at`]=new Date(now+30*60000).toISOString();
      item[key][index]=null;
      await save();
      throw new Error(`${prefix}: carousel child ${index+1} ${child.status}; retained other uploads`);
    }
    await save();
  }
  if(!item[key].every(child=>child?.status==='FINISHED')) return null;
  return advanceContainer({item,prefix,create:()=>createParent(item[key].map(c=>c.id)),inspect,publish,save,now});
}
