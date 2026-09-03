import fs from 'node:fs/promises';
import {reportingGate,storyFingerprint} from './editorial-policy.mjs';
const queue=await Promise.all((await fs.readdir('queue')).filter(x=>x.endsWith('.json')).map(async file=>({file,...JSON.parse(await fs.readFile('queue/'+file,'utf8'))})));
const pending=queue.filter(x=>!x.instagram_media_id&&!x.threads_media_id&&['ready','review'].includes(x.status));
const candidates=pending.map(x=>({id:x.id,queue_file:'queue/'+x.file,source_handle:x.source_handle,source_url:x.source_url,
  headline:x.headline,body:x.body,claim_sha256:x.news_verification?.claim_sha256||null,
  reasons:reportingGate(x).reasons,caption_error:x.threads_copy_error||null,story_fingerprint:storyFingerprint(x.body)}))
  .filter(x=>x.reasons.length||x.caption_error).slice(0,20);
const value={checked_at:new Date().toISOString(),mode:'research_not_auto_approval',candidates,
  instructions:'Check primary documents and two independent reports. Preserve the exact claim, dates, actual case posture, and source URLs. Record reviewed claim hash. Never approve based only on a model score or repeated social captions.'};
await fs.mkdir('logs',{recursive:true});
await fs.writeFile('logs/editorial-inbox.json',JSON.stringify(value,null,2)+'\n');
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\nEditorial inbox: '+candidates.length+' items need reporting or caption review. See logs/editorial-inbox.json.\n');
