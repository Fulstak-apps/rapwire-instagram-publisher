import test from 'node:test';
import assert from 'node:assert/strict';
import {isRapWirePage, resolveRapWireFacebookTarget} from './facebook-target.mjs';

function response(body, ok = true, status = 200) {
  return {ok, status, async json(){ return body; }};
}

test('recognizes RapWire 24/7 by name or username only', () => {
  assert.equal(isRapWirePage({name:'Rap Wire 24/7'}), true);
  assert.equal(isRapWirePage({username:'rapwire247'}), true);
  assert.equal(isRapWirePage({name:'Darnell Williams'}), false);
});

test('selects the RapWire page from managed pages and ignores personal page', async () => {
  const fetchImpl = async url => {
    if (String(url).includes('/me/accounts')) return response({data:[
      {id:'1', name:'Darnell Williams', access_token:'wrong'},
      {id:'2', name:'Rap Wire 24/7', username:'rapwire247', access_token:'right'}
    ]});
    throw new Error('unexpected request');
  };
  const result = await resolveRapWireFacebookTarget({token:'user-token', fetchImpl});
  assert.equal(result.configured, true);
  assert.equal(result.pageId, '2');
  assert.equal(result.pageToken, 'right');
});

test('refuses an explicit non-RapWire page', async () => {
  const fetchImpl = async () => response({id:'1', name:'Darnell Williams', username:'darnell'});
  const result = await resolveRapWireFacebookTarget({token:'token', explicitPageId:'1', fetchImpl});
  assert.equal(result.configured, false);
  assert.equal(result.reason, 'explicit_page_identity_mismatch');
});
