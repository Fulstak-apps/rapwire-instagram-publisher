import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRanges } from './media-ranges.mjs';
const part = (start,text,total=6) => ({rangeStart:start,body:Buffer.from(text),status:206,headers:{'content-range':`bytes ${start}-${start+text.length-1}/${total}`}});
test('overlapping retransmissions assemble once',()=>assert.equal(assembleRanges([part(0,'abc'),part(2,'cdef'),part(0,'ab')]).toString(),'abcdef'));
test('missing ranges are never accepted',()=>assert.equal(assembleRanges([part(0,'ab'),part(3,'def')]),null));
test('partial tail is never accepted',()=>assert.equal(assembleRanges([part(0,'abc')]),null));
test('full HTTP 200 is accepted without range headers',()=>assert.equal(assembleRanges([{rangeStart:0,body:Buffer.from('abcdef'),status:200,headers:{}}]).toString(),'abcdef'));
test('CDN URL ranges require independent complete-buffer evidence',()=>{
  const parts = [{rangeStart:0,rangeEnd:2,body:Buffer.from('abc'),status:200,headers:{}},{rangeStart:2,rangeEnd:5,body:Buffer.from('cdef'),status:200,headers:{}}];
  assert.equal(assembleRanges(parts),null);
  assert.equal(assembleRanges(parts,{allowBufferedRanges:true}).toString(),'abcdef');
  assert.equal(assembleRanges([parts[1]],{allowBufferedRanges:true}),null);
});
