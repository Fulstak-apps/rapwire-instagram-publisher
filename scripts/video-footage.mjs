import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec = promisify(execFile);
export const VIDEO_LAYOUT_VERSION = 'footage-only-v1';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export function sampleTimes(duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid source video duration');
  return [0.03, 0.25, 0.5, 0.75, 0.97].map(fraction => duration * fraction);
}

// A panel must be predominantly the SAME neutral background and static across
// every sample. This deliberately does not use a fixed percentage crop.
export function inspectBands(frames, width, height) {
  if (frames.length < 5 || frames.some(frame => frame.length !== width * height * 3)) throw new Error('Five complete RGB samples are required');
  function neutralLine(indices, pure = false) {
    let allBlack = true, allWhite = true, delta = 0;
    for (const frame of frames) {
      let black = 0, white = 0, gray = 0;
      for (const p of indices) {
        const r=frame[p], g=frame[p+1], b=frame[p+2];
        if (Math.max(r,g,b) < 30) black++;
        if (Math.min(r,g,b) > 225 && Math.max(r,g,b)-Math.min(r,g,b) < 20) white++;
        if (Math.max(r,g,b)-Math.min(r,g,b)<20) gray++;
      }
      const neutral=(black+white)/indices.length;
      allBlack &&= pure ? black/indices.length>=0.995 : black/indices.length>=0.72 || black/indices.length>=0.55 && neutral>=0.80 || black/indices.length>=0.40 && gray/indices.length>=0.85;
      allWhite &&= pure ? white/indices.length>=0.995 : white/indices.length>=0.72 || white/indices.length>=0.55 && neutral>=0.80 || white/indices.length>=0.40 && gray/indices.length>=0.85;
    }
    if (!allBlack && !allWhite) return false;
    for (const frame of frames.slice(1)) for (const p of indices) {
      delta += (Math.abs(frame[p]-frames[0][p]) + Math.abs(frame[p+1]-frames[0][p+1]) + Math.abs(frame[p+2]-frames[0][p+2])) / 3;
    }
    return delta / ((frames.length-1) * indices.length) < 3;
  }
  const rows=Array.from({length:height},(_,y)=>neutralLine(Array.from({length:width},(_,x)=>(y*width+x)*3)));
  // Two boundary pixels may contain codec ringing, but never skip a run of
  // non-panel rows to reach a more convenient crop further inside the footage.
  const edge = values => {
    let last=0, misses=0;
    for (let i=0;i<values.length;i++) {
      if (values[i]) {last=i+1;misses=0;} else if (++misses >= 3) break;
    }
    return last;
  };
  const top=edge(rows), bottom=height-edge([...rows].reverse());
  if (bottom-top < height*0.35) return {ambiguous:true,reason:'No distinct footage region between static panels'};
  const columns=Array.from({length:width},(_,x)=>neutralLine(Array.from({length:bottom-top},(_,n)=>((top+n)*width+x)*3),true));
  const left=edge(columns), right=width-edge([...columns].reverse());
  if (right-left < width*0.7) return {ambiguous:true,reason:'Side crop would remove too much source content'};
  return {x:left,y:top,width:right-left,height:bottom-top};
}

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g,'');
const aliases = handle => [handle, {records:'records',traploreross:'trap lore ross',freshouttheculture:'fresh out the culture',raplisted_:'raplisted',complexmusic:'complex music'}[handle]].filter(Boolean).map(normalize);
function sourceBrandLine(item,handle) {
  const escaped=handle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if (new RegExp(`(?:^|\\s)@${escaped}(?![a-z0-9_.])`,'i').test(item.text)) return true;
  const value=normalize(item.text);
  return aliases(handle).some(alias=>value===alias || item.box.y<0.45 && value.startsWith(alias));
}
function outside(box, rect) {
  return box.y + box.height <= rect.y || box.y >= rect.y + rect.height || box.x + box.width <= rect.x || box.x >= rect.x+rect.width;
}
function crosses(box, rect) {
  return !outside(box,rect) && (box.x < rect.x-1e-6 || box.y < rect.y-1e-6 || box.x+box.width > rect.x+rect.width+1e-6 || box.y+box.height > rect.y+rect.height+1e-6);
}

export function chooseFootageCrop({bands, sampleWidth, sampleHeight, sourceWidth, sourceHeight, observations, sourceHandle}) {
  if (!/^[a-z0-9_.]{1,30}$/i.test(sourceHandle||'') || ['p','reel','reels'].includes(sourceHandle)) throw new Error('Crop review required: verified source handle is missing');
  if (bands.ambiguous) throw new Error(`Crop review required: ${bands.reason}`);
  if (!Array.isArray(observations) || observations.length < 5 || observations.some(o=>!Array.isArray(o.text)||!Array.isArray(o.faces))) throw new Error('Crop review required: missing local text/face inspection');
  const text=observations.flatMap(o=>o.text).filter(o=>o.confidence>=0.45);
  const sourceMarks=text.filter(o=>sourceBrandLine(o,sourceHandle));
  const bandRect={x:bands.x/sampleWidth,y:bands.y/sampleHeight,width:bands.width/sampleWidth,height:bands.height/sampleHeight};
  const substantiveTopPanel=bandRect.y>0.035;
  // A lower static strip may contain subtitles or the source-written caption;
  // preserve it. Side strips, though, cannot be removed by this top-header
  // policy without changing the clip's framing.
  const substantiveSidePanel=bandRect.x>0.035 || 1-bandRect.x-bandRect.width>0.035;

  // A repost must never discard the source's substantive on-video copy just to
  // hide an account name.  We therefore remove only the confirmed account
  // header: the slice ends immediately after the handle/logo line, rather than
  // at the beginning of the moving footage.  Captions below that line remain.
  if (!substantiveTopPanel && !substantiveSidePanel) {
    if (sourceMarks.length) throw new Error('Crop review required: source branding overlaps footage instead of a removable outer panel');
    return {crop:{x:0,y:0,width:Math.floor(sourceWidth/2)*2,height:Math.floor(sourceHeight/2)*2},
      method:'full-frame-no-removable-source-header-v1',source_header_removed:false,
      inspected_frames:observations.length,removed_text:[]};
  }
  if (!substantiveTopPanel || substantiveSidePanel) throw new Error('Crop review required: source branding is not isolated in a removable top header');
  if (!sourceMarks.length) throw new Error('Crop review required: static top panel has no confirmed source header');
  const markBottom=Math.max(...sourceMarks.map(o=>o.box.y+o.box.height));
  // The confirmed brand must sit wholly in the neutral top panel.  A small
  // allowance handles antialiasing at its bottom edge but cannot reach caption
  // lines below it.
  if (sourceMarks.some(o=>o.box.y<0 || o.box.y+o.box.height>bandRect.y+0.012)) throw new Error('Crop review required: source branding overlaps footage instead of a removable outer panel');
  const cropTop=Math.min(1,markBottom+Math.max(2/sourceHeight,0.004));
  const rect={x:0,y:cropTop,width:1,height:1-cropTop};
  const nonSourceText=text.filter(o=>!sourceBrandLine(o,sourceHandle));
  // A boundary through a caption, subtitle, or title is never acceptable.
  if (nonSourceText.some(o=>outside(o.box,rect)||crosses(o.box,rect))) throw new Error('Crop review required: proposed edge intersects text or excludes in-video caption');
  if (sourceMarks.some(o=>!outside(o.box,rect))) throw new Error('Crop review required: source branding overlaps footage instead of a removable outer panel');
  // Profile avatars are part of the removable brand header.  A face straddling
  // the crop edge is not safe, and a face below it is retained.
  if (observations.some(o=>o.faces.some(face=>crosses(face,rect)))) throw new Error('Crop review required: proposed edge intersects a face');
  // Integer chroma-safe rectangle. Outward rounding protects boundary pixels.
  const x=Math.floor(rect.x*sourceWidth/2)*2, y=Math.floor(rect.y*sourceHeight/2)*2;
  const right=Math.min(sourceWidth,Math.ceil((rect.x+rect.width)*sourceWidth/2)*2);
  const bottom=Math.min(sourceHeight,Math.ceil((rect.y+rect.height)*sourceHeight/2)*2);
  return {crop:{x,y,width:Math.floor((right-x)/2)*2,height:Math.floor((bottom-y)/2)*2},
    method:'source-header-only-local-ocr-v1',source_header_removed:true,
    inspected_frames:observations.length,removed_text:sourceMarks.map(o=>o.text).filter((s,i,a)=>a.indexOf(s)===i)};
}

// When the header-only boundary would cut source-written copy, use the proven
// moving-footage panel itself. This is intentionally a second pass, never a
// percentage guess: inspectBands has already established the exact static top
// panel boundary across five sampled frames. The written Instagram caption
// supplies the context below the clip.
export function chooseSoloFootageCrop({bands, sampleWidth, sampleHeight, sourceWidth, sourceHeight, observations}) {
  if (bands.ambiguous || !Array.isArray(observations) || observations.length < 5) throw new Error('Crop review required: no proven solo-footage panel is available');
  const x=Math.floor((bands.x/sampleWidth)*sourceWidth/2)*2;
  const y=Math.floor((bands.y/sampleHeight)*sourceHeight/2)*2;
  const right=Math.min(sourceWidth,Math.ceil(((bands.x+bands.width)/sampleWidth)*sourceWidth/2)*2);
  const bottom=Math.min(sourceHeight,Math.ceil(((bands.y+bands.height)/sampleHeight)*sourceHeight/2)*2);
  if (y<=0 || right-x<sourceWidth*.7 || bottom-y<sourceHeight*.35) throw new Error('Crop review required: no proven solo-footage panel is available');
  return {crop:{x,y,width:Math.floor((right-x)/2)*2,height:Math.floor((bottom-y)/2)*2},
    method:'proven-solo-footage-panel-fallback-v1',source_header_removed:true,
    caption_panel_removed:true,inspected_frames:observations.length,removed_text:[]};
}

export function chooseLogoSize(crop,sourceWidth,sourceHeight,observations) {
  const scale=Math.min(1080/crop.width,1350/crop.height);
  const offsetX=(1080-crop.width*scale)/2, offsetY=(1350-crop.height*scale)/2;
  const sourceRect={x:crop.x/sourceWidth,y:crop.y/sourceHeight,width:crop.width/sourceWidth,height:crop.height/sourceHeight};
  const boxes=observations.flatMap(o=>[...o.faces,...o.text.filter(t=>t.confidence>=.45).map(t=>t.box)])
    .filter(box=>!outside(box,sourceRect)).map(box=>({x:(box.x*sourceWidth-crop.x)*scale+offsetX,y:(box.y*sourceHeight-crop.y)*scale+offsetY,width:box.width*sourceWidth*scale,height:box.height*sourceHeight*scale}));
  for(const size of [170,132,100]) {
    const logo={x:34,y:1350-size-34,width:size,height:size};
    if(boxes.every(box=>outside(box,logo))) return size;
  }
  throw new Error('Crop review required: bottom-left logo would cover meaningful source text or a face');
}

export function footageFilter(crop, logoIndex=1,logoSize=170) {
  return `[0:v]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},setsar=1,split=2[base][front];[base]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,gblur=sigma=28[blurred];[front]scale=1080:1350:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2[fit];[blurred][fit]overlay=(W-w)/2:(H-h)/2[framed];[${logoIndex}:v]scale=${logoSize}:${logoSize}[bug];[framed][bug]overlay=x=34:y=H-h-34:shortest=1[v]`;
}

export async function analyzeFootage(input,{sourceHandle,directory,width,height,duration}) {
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64) throw new Error('Invalid source video dimensions');
  const times=sampleTimes(duration), sampleWidth=Math.min(360,width), sampleHeight=Math.round(height*sampleWidth/width);
  const frames=[], images=[];
  await fs.mkdir(directory,{recursive:true});
  for (const [i,time] of times.entries()) {
    const {stdout}=await exec('ffmpeg',['-v','error','-ss',String(time),'-i',input,'-frames:v','1','-vf',`scale=${sampleWidth}:${sampleHeight}`,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',maxBuffer:8*1024*1024,timeout:30000});
    frames.push(stdout);
    const image=path.join(directory,`source-${i+1}.png`);
    await exec('ffmpeg',['-v','error','-y','-ss',String(time),'-i',input,'-frames:v','1',image],{timeout:30000});
    images.push(image);
  }
  const bands=inspectBands(frames,sampleWidth,sampleHeight);
  if(bands.ambiguous) {
    await fs.writeFile(path.join(directory,'crop-observations.json'),JSON.stringify({bands,sample_times:times},null,2)+'\n');
    throw new Error(`Crop review required: ${bands.reason}`);
  }
  // Swift compiles/cache-loads Apple's local OCR tool; never calls a paid model.
  const {stdout}=await exec('/usr/bin/swift',[path.join(scriptDir,'inspect-video-frame.swift'),...images],{maxBuffer:8*1024*1024,timeout:180000});
  const observations=JSON.parse(stdout);
  await fs.writeFile(path.join(directory,'crop-observations.json'),JSON.stringify({bands,observations,sample_times:times},null,2)+'\n');
  let plan;
  try {
    plan=chooseFootageCrop({bands,sampleWidth,sampleHeight,sourceWidth:width,sourceHeight:height,observations,sourceHandle});
  } catch (headerOnlyError) {
    // The requested fallback prioritizes a clean playable clip over retaining
    // a source panel. It is still tied to measured panel geometry, never a
    // blind crop. Keep the first failure in the proof for later audit.
    try {
      plan={...chooseSoloFootageCrop({bands,sampleWidth,sampleHeight,sourceWidth:width,sourceHeight:height,observations}),header_only_crop_error:headerOnlyError.message};
    } catch {
      throw headerOnlyError;
    }
  }
  const analysis={...plan,sample_times:times};
  analysis.logo_size=chooseLogoSize(analysis.crop,width,height,observations);
  await fs.writeFile(path.join(directory,'crop-analysis.json'),JSON.stringify({bands,observations,...analysis},null,2)+'\n');
  return analysis;
}

export async function renderFootageOnly({input,destination,sourceHandle,width,height,duration}) {
  const directory=destination.replace(/\.mp4$/i,'-crop-review');
  let analysis;
  try { analysis=await analyzeFootage(input,{sourceHandle,directory,width,height,duration}); }
  catch(error) {
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,'review-required.json'),JSON.stringify({sourceHandle,input,error:error.message,checked_at:new Date().toISOString()},null,2)+'\n');
    throw error;
  }
  await exec('ffmpeg',['-v','error','-y','-i',input,'-loop','1','-i',path.resolve('assets/rapwire247-logo.png'),'-filter_complex',footageFilter(analysis.crop,1,analysis.logo_size),'-map','[v]','-map','0:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart',destination],{timeout:300000,maxBuffer:8*1024*1024});
  const {stdout}=await exec('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height,duration:format=duration','-of','json',destination]);
  const probe=JSON.parse(stdout), video=probe.streams?.find(s=>s.codec_type==='video'), audio=probe.streams?.find(s=>s.codec_type==='audio');
  if(video?.codec_name!=='h264'||video.width!==1080||video.height!==1350||audio?.codec_name!=='aac'||[probe.format,video,audio].some(s=>!Number.isFinite(Number(s?.duration))||Math.abs(Number(s.duration)-duration)>1)) throw new Error('Footage-only output failed complete H.264/AAC duration/dimension validation');
  // Save comparable output samples and a center-grid preview for spot checks.
  for (const [i,time] of analysis.sample_times.entries()) await exec('ffmpeg',['-v','error','-y','-ss',String(time),'-i',destination,'-frames:v','1',path.join(directory,`output-${i+1}.jpg`)],{timeout:30000});
  await exec('ffmpeg',['-v','error','-y','-ss',String(analysis.sample_times[2]),'-i',destination,'-vf','crop=1080:1080:0:135','-frames:v','1',path.join(directory,'center-grid.jpg')],{timeout:30000});
  const hash=async file=>{const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');};
  return {version:VIDEO_LAYOUT_VERSION,status:'validated',source_width:width,source_height:height,output_width:1080,output_height:1350,
    crop:analysis.crop,analysis,source_sha256:await hash(input),output_sha256:await hash(destination),source_path:input,
    caption_overlay:false,logo_position:'bottom-left',checked_at:new Date().toISOString()};
}
