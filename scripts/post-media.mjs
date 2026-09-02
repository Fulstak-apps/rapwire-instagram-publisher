import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sourceCaption, shortcode} from './video-caption.mjs';
const exec = promisify(execFile);

// This function reads rendered DOM only. Intersect every clipping ancestor so
// preloaded neighbors, profile avatars and recommended posts cannot win.
export function readActiveMedia() {
  let articles = [...document.querySelectorAll('article')];
  if (!articles.length) articles = [...document.querySelectorAll('main')];
  if (articles.length !== 1) throw new Error('Expected one exact post article');
  const article = articles[0];
  const media = [...article.querySelectorAll('img, video')];
  const candidates = media.map((el, index) => {
    if (el.closest('a[href*="/p/"], a[href*="/reel/"]')) return null;
    const r = el.getBoundingClientRect();
    let left = Math.max(0,r.left), top = Math.max(0,r.top);
    let right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
    for (let parent=el.parentElement; parent; parent=parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {left=Math.max(left,box.left);right=Math.min(right,box.right);}
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
    }
    const width = el.tagName === 'VIDEO' ? el.videoWidth : el.naturalWidth;
    const height = el.tagName === 'VIDEO' ? el.videoHeight : el.naturalHeight;
    const area = Math.max(0,right-left)*Math.max(0,bottom-top);
    if (r.width<200 || r.height<150 || area<30000) return null;
    return {index,type:el.tagName==='VIDEO'?'video':'image',src:el.currentSrc || el.src,
      width,height,area,duration:el.tagName==='VIDEO'?el.duration:undefined};
  }).filter(Boolean).sort((a,b)=>b.area-a.area || (a.type==='video'?-1:1));
  if (!candidates.length) throw new Error('Exact post media is not loaded');
  const selected=candidates[0];
  // A poster underneath a playing video is not another carousel item.
  if (candidates[1] && candidates[1].type===selected.type && candidates[1].area>selected.area*0.8) {
    throw new Error('Ambiguous active slide; wait for carousel transition');
  }
  return selected;
}

export async function walkPost({read, saveItem, next, advance, maxItems=20}) {
  const items=[];
  const seen=new Set();
  for (let index=0; index<maxItems; index++) {
    const current=await read(index);
    const key=current.key || current.src;
    if (!key || seen.has(key)) throw new Error('Carousel did not advance; incomplete post stays pending');
    seen.add(key);
    items.push(await saveItem(current,index));
    if (!await next()) return items;
    await advance(index);
  }
  throw new Error('Carousel exceeds capture bound; incomplete post stays pending');
}

export async function renderPhoto(input,destination,story=false) {
  const height=story?1920:1350;
  // Reserve a footer for the logo: never cover words in source screenshots.
  const mediaHeight=height-210;
  await exec('ffmpeg',['-y','-i',input,'-i',path.resolve('assets/rapwire247-logo.png'),
    '-filter_complex',`[0:v]scale=1040:${mediaHeight}:force_original_aspect_ratio=decrease,pad=1080:${height}:(ow-iw)/2:(${mediaHeight}-ih)/2+20:color=0x101014[base];[1:v]scale=150:150[logo];[base][logo]overlay=34:H-h-30[out]`,
    '-map','[out]','-frames:v','1','-q:v','2',destination]);
  const {stdout}=await exec('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',destination]);
  const info=JSON.parse(stdout).streams?.[0];
  if (info?.width!==1080 || info?.height!==height || (await fs.stat(destination)).size>8*1024*1024) throw new Error('Photo render failed validation');
}

export async function capturePostMedia({page,requestedUrl,outputDir,captureVideo}) {
  const code=shortcode(requestedUrl);
  const article=page.locator(await page.locator('article').count() ? 'article' : 'main');
  await article.waitFor({state:'visible',timeout:20000});
  if (await article.count()!==1) throw new Error('Expected one exact post');
  const get=property=>page.locator(`meta[property="${property}"]`).getAttribute('content',{timeout:5000}).catch(()=>'');
  const canonical=await get('og:url');
  if (shortcode(canonical)!==code || shortcode(page.url())!==code) throw new Error('Post identity changed during capture');
  const heading=await article.locator('h1').allTextContents();
  const caption=sourceCaption({requestedUrl,canonicalUrl:canonical,title:await get('og:title'),description:await get('og:description'),heading:heading.length===1?heading[0]:'',allowSparse:true});
  const back=article.getByRole('button',{name:'Go back',exact:true});
  if (await back.isVisible().catch(()=>false)) throw new Error('Capture must begin on the first carousel slide');
  let previous='';
  const items=await walkPost({
    read:async index=>{
      let lastError;
      for(let attempt=0;attempt<15;attempt++) {
        try {
          if(shortcode(page.url())!==code) throw new Error('Navigation left the requested post');
          const current=await page.evaluate(readActiveMedia);
          if(!current.width || !current.height || !current.src || current.src===previous) throw new Error('Waiting for next slide');
          // Stable media identity, independent of expiring CDN query strings.
          current.key=current.src.startsWith('http')?new URL(current.src).pathname:current.src;
          return current;
        } catch(error) {lastError=error;await page.waitForTimeout(500);}
      }
      throw lastError;
    },
    saveItem:async(current,index)=>{
      previous=current.src;
      const destination=path.join(outputDir,`${code}-${index+1}.${current.type==='video'?'mp4':'jpg'}`);
      let videoEvidence;
      if(current.type==='video') {
        videoEvidence=await captureVideo(article.locator('img, video').nth(current.index),destination,`${code}-${index+1}`);
      } else {
        const url=new URL(current.src);
        if(url.protocol!=='https:' || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) throw new Error('Unexpected source image host');
        const response=await page.request.get(current.src,{timeout:30000});
        if(!response.ok() || !response.headers()['content-type']?.startsWith('image/')) throw new Error('Source image download failed');
        const input=path.join(outputDir,`${code}-${index+1}-original`);
        await fs.writeFile(input,await response.body());
        await renderPhoto(input,destination);
      }
      return {type:current.type,path:destination,source_media_url:current.src,
        width:current.width,height:current.height,duration:videoEvidence?.duration,
        bytes:(await fs.stat(destination)).size};
    },
    next:()=>article.getByRole('button',{name:'Next',exact:true}).isVisible().catch(()=>false),
    advance:async()=>{await article.getByRole('button',{name:'Next',exact:true}).click();await page.waitForTimeout(600);}
  });
  // Meta's Instagram publishing API accepts up to 10 children. Preserve larger
  // complete captures for retry; never silently slice a source carousel.
  if(items.length>10) throw new Error(`Complete ${items.length}-item carousel saved; exceeds Instagram API limit of 10 and needs split delivery`);
  const story=path.join(outputDir,`${code}-story.jpg`);
  // Story is a preview; the complete ordered post is delivered in the feed.
  const storyInput=items[0].type==='image'?path.join(outputDir,`${code}-1-original`):items[0].path;
  await renderPhoto(storyInput,story,true);
  const evidence={source_url:canonical,source_caption_text:caption,shortcode:code,
    content_type:items.length===1?items[0].type:'carousel',items,story,
    complete:true,item_count:items.length,captured_at:new Date().toISOString(),
    media_match_method:'exact-post-ordered-dom-v1'};
  if(items.length===1 && items[0].type==='video') {
    // Keep the legacy video repair path and Reel queue shape compatible.
    evidence.duration=items[0].duration;
    evidence.destination=path.join(outputDir,`${code}.mp4`);
    await fs.copyFile(items[0].path,evidence.destination);
  }
  await fs.writeFile(path.join(outputDir,`${code}.json`),JSON.stringify(evidence,null,2)+'\n');
  return evidence;
}
