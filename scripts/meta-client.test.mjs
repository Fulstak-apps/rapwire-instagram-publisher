import test from 'node:test';
import assert from 'node:assert/strict';
import {metaClient,errorDelay} from './meta-client.mjs';

const TOKEN='fixture-only-access-token';
const response=(status,body,retryAfter=null)=>({ok:status>=200&&status<300,status,
  headers:{get:key=>key==='retry-after'?retryAfter:null},json:async()=>body});

test('Meta client sends GET query parameters and POST form parameters',async()=>{
  const calls=[];
  const api=metaClient('https://example.invalid/v1.0',TOKEN,async(url,options)=>{
    calls.push({url,options});return response(200,{id:'result'});
  });
  assert.deepEqual(await api.get('/me',{fields:'id,username'}),{id:'result'});
  assert.equal(calls[0].url.searchParams.get('access_token'),TOKEN);
  assert.equal(calls[0].url.searchParams.get('fields'),'id,username');
  await api.post('/account/threads',{text:'Saved reply text',reply_to_id:'comment'});
  assert.equal(calls[1].options.body.get('access_token'),TOKEN);
  assert.equal(calls[1].options.body.get('reply_to_id'),'comment');
  assert.equal(calls[1].url.searchParams.get('access_token'),null);
});

test('only explicit non-server API rejection is safe to retry after publishing',async()=>{
  for(const [status,body,definitive] of [
    [429,{error:{message:'Slow down '+TOKEN,code:4}},true],
    [500,{error:{message:'Server lost state '+TOKEN,code:2}},false],
    [400,{},false],
  ]) {
    const api=metaClient('https://example.invalid',TOKEN,async()=>response(status,body,'60'));
    await assert.rejects(api.post('/publish',{}),error=>{
      assert.equal(error.definitiveRejection,definitive);
      assert.equal(error.status,status);
      assert.equal(error.retryAfter,'60');
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  }
});

test('transport and decoding failures redact credentials and never claim definitive rejection',async()=>{
  for(const transport of [
    async()=>{throw new Error('Network failure at https://example.invalid/?access_token='+TOKEN);},
    async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>{throw new SyntaxError('Invalid payload containing '+TOKEN);}}),
  ]) {
    const api=metaClient('https://example.invalid',TOKEN,transport);
    await assert.rejects(api.post('/publish',{}),error=>{
      assert.ok(!error.message.includes(TOKEN));
      assert.match(error.message,/\[redacted\]/);
      assert.notEqual(error.definitiveRejection,true);
      return true;
    });
  }
});

test('cooldowns honor retry-after seconds or dates with longer permission-error backoff',()=>{
  const now=Date.parse('2026-09-03T05:00:00Z');
  assert.equal(errorDelay({},now),3600000);
  assert.equal(errorDelay({retryAfter:'90000'},now),90000000);
  assert.equal(errorDelay({retryAfter:new Date(now+2*3600000).toUTCString()},now),2*3600000);
  assert.equal(errorDelay({code:190,retryAfter:'60'},now),86400000);
  assert.equal(errorDelay({retryAfter:'not a date'},now),3600000);
});
