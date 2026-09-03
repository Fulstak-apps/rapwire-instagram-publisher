import fs from 'node:fs/promises';

const token = process.env.THREADS_ACCESS_TOKEN;
const userId = process.env.THREADS_USER_ID;
const base = 'https://graph.threads.net/v1.0';
const statePath = 'logs/threads-replies.json';
const maxReplyLength = 500;
const cooldownMs = 30 * 60_000;

if (!token || !userId) {
  console.log(JSON.stringify({ status: 'disabled', reason: 'Threads credentials are not configured' }));
  process.exit(0);
}

const state = JSON.parse(await fs.readFile(statePath, 'utf8').catch(() => '{}'));
state.replied_ids ||= {};
if (Date.parse(state.last_reply_at || '') + cooldownMs > Date.now()) {
  console.log(JSON.stringify({ status: 'cooldown', next_at: new Date(Date.parse(state.last_reply_at) + cooldownMs).toISOString() }));
  process.exit(0);
}

async function get(pathname, params = {}) {
  const url = new URL(`${base}${pathname}`);
  for (const [key, value] of Object.entries({ ...params, access_token: token })) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(JSON.stringify(payload));
  return payload;
}
async function post(pathname, fields) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST', body: new URLSearchParams({ ...fields, access_token: token }),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(JSON.stringify(payload));
  return payload;
}

function replyFor(text) {
  const value = String(text || '').trim();
  const lower = value.toLowerCase();
  if (/agree|exactly|facts|true|right|well said/.test(lower)) return 'That is a fair read. The detail that matters is what the confirmed record actually shows.';
  if (/cap|wrong|no way|false|disagree|not true/.test(lower)) return 'Pushback is fair, but which specific fact in the post do you think is wrong?';
  if (/top|best|greatest|goat|rank/.test(lower)) return 'That is the debate: are we ranking peak skill, full career impact, or cultural influence?';
  return 'Interesting perspective. What part of the story carries the most weight for you?';
}

try {
  const own = await get(`/${userId}/threads`, { fields: 'id,text,timestamp,username,is_reply', limit: '25' });
  const posts = (own.data || []).filter(item => item.id && !item.is_reply);
  for (const post of posts) {
    const replies = await get(`/${post.id}/replies`, { fields: 'id,text,timestamp,username,is_reply_owned_by_me', reverse: 'false', limit: '50' });
    for (const reply of (replies.data || [])) {
      const text = String(reply.text || '').trim();
      if (!reply.id || reply.is_reply_owned_by_me || state.replied_ids[reply.id] || text.length < 8 || text.length > 1000) continue;
      if (/(follow me|dm me|crypto|giveaway|https?:\/\/)/i.test(text)) { state.replied_ids[reply.id] = { skipped: true, at: new Date().toISOString() }; continue; }
      const textReply = replyFor(text).slice(0, maxReplyLength);
      const container = await post(`/${userId}/threads`, { media_type: 'TEXT', text: textReply, reply_to_id: reply.id });
      let status = '';
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const check = await get(`/${container.id}`, { fields: 'status,error_message' });
        status = check.status || '';
        if (status === 'FINISHED') break;
        if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Reply container ${container.id}: ${JSON.stringify(check)}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      if (status !== 'FINISHED') throw new Error(`Reply container ${container.id} did not finish in time`);
      const published = await post(`/${userId}/threads_publish`, { creation_id: container.id });
      state.replied_ids[reply.id] = { at: new Date().toISOString(), reply_id: published.id, source_post_id: post.id };
      state.last_reply_at = new Date().toISOString();
      await fs.mkdir('logs', { recursive: true });
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      console.log(JSON.stringify({ status: 'replied', reply_to: reply.id, reply_id: published.id, text: textReply }));
      process.exit(0);
    }
  }
  await fs.mkdir('logs', { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'no_eligible_replies' }));
} catch (error) {
  await fs.mkdir('logs', { recursive: true });
  state.last_error = String(error.message || error).slice(0, 1000);
  state.last_error_at = new Date().toISOString();
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'failed', error: state.last_error }));
  process.exit(0);
}
