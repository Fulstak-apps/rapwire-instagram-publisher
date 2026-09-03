import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleTimes,inspectBands,chooseFootageCrop,chooseSoloFootageCrop,chooseLogoSize,footageFilter} from './video-footage.mjs';

const width=100,height=160;
function frames({top=50,bottom=150,background=0,movingHeader=false}={}) {
  return Array.from({length:5},(_,f)=>{
    const a=Buffer.alloc(width*height*3,background);
    for(let y=top;y<bottom;y++)for(let x=0;x<width;x++){
      const p=(y*width+x)*3;a[p]=90+f*20;a[p+1]=110+x;a[p+2]=180;
    }
    // Sparse text/avatar marks in a static neutral panel.
    if(top)for(let y=20;y<30;y++)for(let x=10;x<30;x++){
      const p=(y*width+x)*3;a[p]=movingHeader?50*f:255;a[p+1]=background===255?0:255;a[p+2]=0;
    }
    return a;
  });
}
const observations=()=>Array.from({length:5},()=>({text:[
  {text:'Records',confidence:.99,box:{x:.1,y:.08,width:.18,height:.035}},
  {text:'@records',confidence:.99,box:{x:.1,y:.13,width:.2,height:.04}},
  // This represents the source-written headline/caption beneath the account
  // header. It must survive the brand-only crop.
  {text:'The original on-video caption stays readable',confidence:.99,box:{x:.1,y:.22,width:.7,height:.04}}
],faces:[{x:.1,y:.4,width:.15,height:.2}]}));
function choose(bands,obs=observations()) {return chooseFootageCrop({bands,sampleWidth:width,sampleHeight:height,sourceWidth:720,sourceHeight:1152,observations:obs,sourceHandle:'records'});}

test('detects separate black or white headers without a fixed crop percentage',()=>{
  for(const background of [0,255])for(const top of [40,50,65]) {
    const bands=inspectBands(frames({top,background}),width,height);
    assert.deepEqual(bands,{x:0,y:top,width,height:150-top});
  }
});
test('only source header is removed before blur; the source on-video caption stays',()=>{
  const plan=choose(inspectBands(frames(),width,height));
  assert.equal(plan.source_header_removed,true);
  assert.equal(plan.crop.y,200);
  assert.deepEqual(plan.removed_text,['Records','@records']);
  const filter=footageFilter(plan.crop);
  assert.match(filter,/^\[0:v\]crop=720:952:0:200/);
  assert.ok(filter.indexOf('crop=')<filter.indexOf('split='));
  assert.doesNotMatch(filter,/drawtext/);
  assert.match(filter,/overlay=x=34:y=H-h-34/);
});
test('clean full-frame footage remains full-frame',()=>{
  const bands=inspectBands(frames({top:0,bottom:height}),width,height);
  const empty=Array.from({length:5},()=>({text:[],faces:[]}));
  assert.deepEqual(choose(bands,empty).crop,{x:0,y:0,width:720,height:1152});
});
test('a combined source name/handle line in an unrecognized colored panel is held',()=>{
  const bands={x:0,y:0,width,height};
  for(const name of ['Records News','@records more caption text']) {
    const obs=observations();obs.forEach(o=>o.text[0].text=name);
    assert.throws(()=>choose(bands,obs),/overlaps footage/);
  }
});
test('dense gray antialiased caption rows and colored emoji do not become false footage edges',()=>{
  const samples=frames();
  for(const f of samples)for(let y=32;y<40;y++)for(let x=0;x<60;x++) {
    const p=(y*width+x)*3;
    f[p]=x<10?180:180;f[p+1]=x<10?100:180;f[p+2]=x<10?0:180;
  }
  assert.equal(inspectBands(samples,width,height).y,50);
});
test('in-footage subtitles stay intact; text across crop edge is held',()=>{
  const bands=inspectBands(frames(),width,height);
  const obs=observations();
  obs[0].text.push({text:'Meaningful subtitle',confidence:.99,box:{x:.2,y:.6,width:.6,height:.05}});
  assert.ok(choose(bands,obs));
  obs[0].text.push({text:'Boundary subtitle',confidence:.99,box:{x:.2,y:.16,width:.6,height:.05}});
  assert.throws(()=>choose(bands,obs),/intersects text or excludes in-video caption/);
});
test('source mark embedded in footage cannot be cropped or covered',()=>{
  const obs=observations();obs[0].text[0].box.y=.5;
  assert.throws(()=>choose(inspectBands(frames(),width,height),obs),/overlaps footage/);
});
test('unidentified static text panel is held rather than removing primary context',()=>{
  const obs=observations();obs.forEach(o=>o.text=o.text.filter(line=>!/@records|Records/i.test(line.text)));
  assert.throws(()=>choose(inspectBands(frames(),width,height),obs),/no confirmed source header/);
});
test('source avatar entirely inside the header can be removed, but a face crossing the edge holds',()=>{
  const obs=observations();obs[1].faces.push({x:.1,y:.08,width:.08,height:.05});
  assert.ok(choose(inspectBands(frames(),width,height),obs));
  obs[1].faces.push({x:.1,y:.15,width:.1,height:.1});
  assert.throws(()=>choose(inspectBands(frames(),width,height),obs),/intersects a face/);
});
test('Raplisted handle is cropped without losing a caption below it',()=>{
  const obs=Array.from({length:5},()=>({text:[
    {text:'RAPLISTED',confidence:.99,box:{x:.12,y:.08,width:.22,height:.04}},
    {text:'@raplisted_',confidence:.99,box:{x:.12,y:.13,width:.22,height:.04}},
    {text:'Caption is part of the actual post',confidence:.99,box:{x:.1,y:.23,width:.7,height:.04}}
  ],faces:[]}));
  const plan=chooseFootageCrop({bands:inspectBands(frames(),width,height),sampleWidth:width,sampleHeight:height,sourceWidth:720,sourceHeight:1152,observations:obs,sourceHandle:'raplisted_'});
  assert.equal(plan.source_header_removed,true);
  assert.deepEqual(plan.removed_text,['RAPLISTED','@raplisted_']);
  assert.ok(plan.crop.y < Math.floor(.23*1152));
});
test('unclean header falls back to the measured solo-footage panel instead of a blind crop',()=>{
  const bands=inspectBands(frames(),width,height);
  const plan=chooseSoloFootageCrop({bands,sampleWidth:width,sampleHeight:height,sourceWidth:720,sourceHeight:1152,observations:observations()});
  assert.deepEqual(plan.crop,{x:0,y:360,width:720,height:720});
  assert.equal(plan.caption_panel_removed,true);
  assert.equal(plan.method,'proven-solo-footage-panel-fallback-v1');
});
test('blank/static video without a distinct footage region is held',()=>{
  assert.equal(inspectBands(Array.from({length:5},()=>Buffer.alloc(width*height*3)),width,height).ambiguous,true);
});
test('complete evenly spread samples and OCR are required',()=>{
  assert.deepEqual(sampleTimes(100),[3,25,50,75,97]);
  assert.throws(()=>sampleTimes(NaN),/duration/);
  assert.throws(()=>inspectBands(frames().slice(0,3),width,height),/Five complete/);
  assert.throws(()=>choose(inspectBands(frames(),width,height),[]),/missing local/);
});
test('bottom-left logo shrinks to preserve subtitles, or holds if none fits',()=>{
  const crop={x:0,y:0,width:1080,height:1350};
  const obs=Array.from({length:5},()=>({faces:[],text:[{confidence:1,box:{x:.04,y:1150/1350,width:.15,height:20/1350}}]}));
  assert.equal(chooseLogoSize(crop,1080,1350,obs),132);
  obs[0].text[0].box.y=1220/1350;
  assert.throws(()=>chooseLogoSize(crop,1080,1350,obs),/logo would cover/);
});
test('canonical URL path is not a source-handle identity',()=>{
  assert.throws(()=>chooseFootageCrop({bands:{x:0,y:0,width,height},sampleWidth:width,sampleHeight:height,sourceWidth:720,sourceHeight:1152,observations:observations(),sourceHandle:'p'}),/source handle is missing/);
});
