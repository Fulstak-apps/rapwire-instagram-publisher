import fs from 'node:fs/promises';
import path from 'node:path';

const graphBase = 'https://graph.facebook.com';
const logsDir = 'logs';
const healthPath = path.join(logsDir, 'facebook-target-health.json');

export const normalizeFacebookPageName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function isRapWirePage(page, expectedName = 'RapWire 24/7') {
  const expected = normalizeFacebookPageName(expectedName);
  const aliases = new Set([expected, 'rapwire247']);
  return aliases.has(normalizeFacebookPageName(page?.name)) || aliases.has(normalizeFacebookPageName(page?.username));
}

async function graphGet(endpoint, token, fields, fetchImpl = fetch) {
  const url = new URL(`${graphBase}${endpoint}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(20_000)});
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || `Facebook request failed (${response.status})`);
  return body;
}

export async function resolveRapWireFacebookTarget({token, explicitPageId, expectedName = 'RapWire 24/7', fetchImpl = fetch} = {}) {
  if (!token) return {configured:false, reason:'facebook_access_token_missing'};

  if (explicitPageId) {
    try {
      const page = await graphGet(`/${explicitPageId}`, token, 'id,name,username,access_token', fetchImpl);
      if (!isRapWirePage(page, expectedName)) {
        return {configured:false, reason:'explicit_page_identity_mismatch', observed:{id:page.id,name:page.name,username:page.username || null}};
      }
      return {configured:true, pageId:String(page.id), pageName:page.name, username:page.username || null, pageToken:page.access_token || token, source:'explicit_page'};
    } catch (error) {
      return {configured:false, reason:'explicit_page_lookup_failed', error:error.message};
    }
  }

  try {
    const accounts = await graphGet('/me/accounts', token, 'id,name,username,access_token', fetchImpl);
    const matches = (accounts.data || []).filter(page => isRapWirePage(page, expectedName));
    if (matches.length === 1) {
      const page = matches[0];
      return {configured:true, pageId:String(page.id), pageName:page.name, username:page.username || null, pageToken:page.access_token || token, source:'managed_pages'};
    }
    if (matches.length > 1) return {configured:false, reason:'multiple_rapwire_pages_found'};
  } catch (error) {
    // A Page-scoped token may not expose /me/accounts. Check whether the token
    // itself belongs to RapWire before giving up.
  }

  try {
    const me = await graphGet('/me', token, 'id,name,username', fetchImpl);
    if (isRapWirePage(me, expectedName)) {
      return {configured:true, pageId:String(me.id), pageName:me.name, username:me.username || null, pageToken:token, source:'page_token_identity'};
    }
    return {configured:false, reason:'rapwire_page_not_found', observed:{id:me.id,name:me.name,username:me.username || null}};
  } catch (error) {
    return {configured:false, reason:'facebook_identity_unavailable', error:error.message};
  }
}

async function appendGithubEnv(key, value) {
  if (!process.env.GITHUB_ENV) return;
  await fs.appendFile(process.env.GITHUB_ENV, `${key}=${value}\n`);
}

export async function main() {
  const token = process.env.FACEBOOK_DISCOVERY_ACCESS_TOKEN;
  const explicitPageId = process.env.RAPWIRE_FACEBOOK_PAGE_ID;
  const expectedName = process.env.RAPWIRE_FACEBOOK_EXPECTED_NAME || 'RapWire 24/7';
  const result = await resolveRapWireFacebookTarget({token, explicitPageId, expectedName});
  await fs.mkdir(logsDir, {recursive:true});
  const safe = {...result};
  delete safe.pageToken;
  await fs.writeFile(healthPath, `${JSON.stringify({checked_at:new Date().toISOString(), ...safe}, null, 2)}\n`);

  if (!result.configured) {
    console.warn(`Facebook target: disabled (${result.reason})${result.observed?.name ? `; observed Page/account ${result.observed.name}` : ''}`);
    return;
  }

  if (process.stdout.isTTY === false) console.log(`::add-mask::${result.pageToken}`);
  await appendGithubEnv('FACEBOOK_PAGE_ACCESS_TOKEN', result.pageToken);
  await appendGithubEnv('FACEBOOK_PAGE_ID', result.pageId);
  console.log(`Facebook target: verified ${result.pageName} (${result.pageId}) via ${result.source}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
