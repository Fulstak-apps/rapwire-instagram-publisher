import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSources,dailySourceDeficits,dueSources} from './source-policy.mjs';

test('artist minimum reserves two Reel slots and honors an explicit posts exclusion',()=>{
  const [artist]=normalizeSources({sources:[{handle:'darnellwilliams',scope:'hiphop',enabled:true,approved_by:'user',daily_minimum:2,include_posts:false}]});
  assert.equal(artist.includePosts,false);
  assert.equal(artist.includeReels,true);
  const now=Date.parse('2026-09-03T18:00:00Z');
  assert.deepEqual(dailySourceDeficits([artist],[],now).map(x=>x.remaining),[2]);
  const once=[{source_handle:'darnellwilliams',status:'ready',date:'2026-09-03'}];
  assert.deepEqual(dailySourceDeficits([artist],once,now).map(x=>x.remaining),[1]);
  const twice=[...once,{source_handle:'darnellwilliams',status:'ready',date:'2026-09-03'}];
  assert.deepEqual(dailySourceDeficits([artist],twice,now),[]);
});

test('invalid daily minimum is rejected',()=>{
  assert.throws(()=>normalizeSources({sources:[{handle:'darnellwilliams',scope:'hiphop',enabled:true,approved_by:'user',daily_minimum:5}]}),/daily source minimum/);
});

test('fast-track hip-hop sources are due every ten minutes without displacing VIP checks',()=>{
  const [fast,normal,vip]=normalizeSources({sources:[
    {handle:'complexmusic',scope:'hiphop',enabled:true,approved_by:'user',fast_track:true},
    {handle:'xxl',scope:'hiphop',enabled:true,approved_by:'user'},
    {handle:'akademiks',scope:'hiphop',enabled:true,approved_by:'user'}
  ]});
  const now=Date.parse('2026-09-03T18:00:00Z');
  const checks={complexmusic:{checked_at:new Date(now-11*60000).toISOString()},xxl:{checked_at:new Date(now-11*60000).toISOString()},akademiks:{checked_at:new Date(now-6*60000).toISOString()}};
  assert.deepEqual(dueSources([fast,normal,vip],{source_checks:checks},now).map(source=>source.handle),['akademiks','complexmusic']);
});
