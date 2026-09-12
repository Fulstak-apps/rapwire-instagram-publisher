// Read-only diagnostics. Never log credentials, request URLs, or raw responses.
// Scheduled checks use --require-valid so GitHub marks a revoked credential as
// a visible failure instead of quietly succeeding while delivery is broken.
const requireValid = process.argv.includes('--require-valid');
let failures = 0;
const checks = [
  ['instagram identity', 'https://graph.instagram.com/me?fields=user_id,username', process.env.INSTAGRAM_ACCESS_TOKEN],
  ['threads identity', 'https://graph.threads.net/v1.0/me?fields=id,username', process.env.THREADS_ACCESS_TOKEN],
  ['threads token', 'https://graph.threads.net/debug_token', process.env.THREADS_ACCESS_TOKEN, true],
];
if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID) {
  checks.push(['facebook page', `https://graph.facebook.com/v26.0/${encodeURIComponent(process.env.FACEBOOK_PAGE_ID)}?fields=id,name`, process.env.FACEBOOK_PAGE_ACCESS_TOKEN]);
}
for (const [label, endpoint, token, debug] of checks) {
  if (!token) {
    console.log(`${label}: missing credential`);
    if (requireValid) failures += 1;
    continue;
  }
  try {
    const url = new URL(endpoint);
    if (debug) url.searchParams.set('input_token', token);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    const data = body.data || body;
    const valid = response.ok && !body.error && data.is_valid !== false;
    console.log(JSON.stringify({check:label,status:response.status,error_code:body.error?.code,error_subcode:body.error?.error_subcode,message:body.error?.message,is_valid:data.is_valid,app_id:data.app_id,expires_at:data.expires_at,scopes:data.scopes,username:data.username}));
    if (requireValid && !valid) failures += 1;
  } catch {
    console.log(`${label}: request could not complete`);
    if (requireValid) failures += 1;
  }
}
if (requireValid && failures) process.exitCode = 1;
