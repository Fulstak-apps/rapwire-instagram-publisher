import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const logsDir = 'logs';
const quotaPath = path.join(logsDir, 'instagram-publishing-quota.json');
const healthPath = path.join(logsDir, 'instagram-auth-health.json');

export function isInstagramAuthFailureReason(reason = '') {
  return /error validating access token|session has been invalidated|oauth(?:exception)?.*code[^0-9]*190|\"code\"\s*:\s*190/i.test(String(reason));
}

export function recoverQuotaAfterValidAuth(quota = {}, now = Date.now()) {
  if (quota.blocked !== true || !isInstagramAuthFailureReason(quota.reason)) return {quota, changed: false};
  const recovered = {
    ...quota,
    blocked: false,
    next_check_at: null,
    reason: 'Instagram authentication recovered; forcing a fresh publishing-capacity check',
    auth_recovered_at: new Date(now).toISOString()
  };
  return {quota: recovered, changed: true};
}

export async function checkInstagramIdentity({token, userId, fetchImpl = fetch, timeoutMs = 20_000} = {}) {
  if (!token || !userId) return {valid: false, status: null, error_code: null, message: 'Instagram credential or user ID is missing'};
  try {
    const url = new URL('https://graph.instagram.com/me');
    url.searchParams.set('fields', 'user_id,username');
    const response = await fetchImpl(url, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json();
    const returnedId = String(body.user_id || body.id || '');
    const expectedId = String(userId);
    const valid = response.ok && !body.error && returnedId === expectedId;
    return {
      valid,
      status: response.status,
      error_code: body.error?.code ?? null,
      error_subcode: body.error?.error_subcode ?? null,
      message: body.error?.message || (valid ? 'Instagram identity verified' : `Instagram identity mismatch: expected configured user ID, received ${returnedId || 'none'}`),
      username: body.username || null
    };
  } catch (error) {
    return {valid: false, status: null, error_code: null, error_subcode: null, message: `Instagram identity check could not complete: ${error.message}`};
  }
}

export async function main() {
  const checkedAt = new Date().toISOString();
  const result = await checkInstagramIdentity({
    token: process.env.INSTAGRAM_ACCESS_TOKEN,
    userId: process.env.INSTAGRAM_USER_ID
  });
  await fs.mkdir(logsDir, {recursive: true});
  await fs.writeFile(healthPath, `${JSON.stringify({checked_at: checkedAt, ...result}, null, 2)}\n`);

  if (!result.valid) {
    console.warn(`Instagram auth health: unavailable${result.error_code ? ` (Meta code ${result.error_code})` : ''}: ${result.message}`);
    return;
  }

  const quota = JSON.parse(await fs.readFile(quotaPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  }));
  const recovery = recoverQuotaAfterValidAuth(quota);
  if (recovery.changed) {
    await fs.writeFile(quotaPath, `${JSON.stringify(recovery.quota, null, 2)}\n`);
    console.log('Instagram auth health: credential recovered; stale auth hold cleared for immediate quota refresh.');
  } else {
    console.log(`Instagram auth health: verified${result.username ? ` as @${result.username}` : ''}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
