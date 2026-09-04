// Read-only diagnostics. Never log credentials, request URLs, or raw responses.
const checks = [
  ['instagram identity', 'https://graph.instagram.com/me?fields=user_id,username', process.env.INSTAGRAM_ACCESS_TOKEN],
  ['threads identity', 'https://graph.threads.net/v1.0/me?fields=id,username', process.env.THREADS_ACCESS_TOKEN],
  ['threads token', 'https://graph.threads.net/debug_token', process.env.THREADS_ACCESS_TOKEN, true],
];
for (const [label, endpoint, token, debug] of checks) {
  if (!token) { console.log(`${label}: missing credential`); continue; }
  try {
    const url = new URL(endpoint);
    if (debug) url.searchParams.set('input_token', token);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    const data = body.data || body;
    console.log(JSON.stringify({check:label,status:response.status,error_code:body.error?.code,error_subcode:body.error?.error_subcode,message:body.error?.message,is_valid:data.is_valid,app_id:data.app_id,expires_at:data.expires_at,scopes:data.scopes,username:data.username}));
  } catch { console.log(`${label}: request could not complete`); }
}
