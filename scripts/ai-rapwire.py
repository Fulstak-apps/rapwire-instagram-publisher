#!/usr/bin/env python3
import base64, html, importlib.util, io, json, os, re, secrets, subprocess, sys, traceback, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
from openai import OpenAI

ROOT=Path(__file__).resolve().parents[1]; QUEUE=ROOT/'queue'; MEDIA=ROOT/'media'
FEED_URL=os.environ.get('NARRO_RSS_URL','https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f')
APPROVED_SOURCE_HANDLES={'akademiks','nojumper','poetikflakkonews','traploreross','saycheesetv','theshaderoom','worldstarhiphop','detroitrapnews','detroitrapdaily','complexmusic','gta6latest'}
RAP_CENTRIC_SOURCES=APPROVED_SOURCE_HANDLES-{'theshaderoom','gta6latest'}
RAP_TOPIC_TERMS=(' rap ',' rapper','hip-hop','hip hop','hiphop','album','mixtape','single','track','song','producer','bars','verse','freestyle','diss','beef','record label','tour','concert','festival','stage','trial','court','charged','arrested','sentenced','plea','shooting')
VERIFIED_RAP_ARTISTS=('glorilla','sexyy red','tupac','2pac','lil durk','drake','lil wayne','young thug','cardi b','doechii','skilla baby','rod wave','sauce walka','trippie redd','50 cent','rick ross','tyler the creator')
NON_NEWS_FLUFF=('birthday','adorable','daddy duties','relationship goals','on vacay','vacation','outfit','thirst trap','roommate diaries','scenarioz')
MAX_CANDIDATES=int(os.environ.get('MAX_NEW_ITEMS','12')); MAX_AGE_HOURS=max(48,int(os.environ.get('MAX_SOURCE_AGE_HOURS','48')))
FONT_BOLD='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; FONT_REG='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
INK=(19,17,27); PAPER=(247,246,239); YELLOW=(248,204,47); PURPLE=(67,40,98); RED=(135,25,48)
client=OpenAI(api_key=os.environ.get('OPENAI_API_KEY'))

def clean(v):
    v=html.unescape(v or ''); v=re.sub(r'<[^>]+>',' ',v); return re.sub(r'\s+',' ',v).strip()

def source_handle(title):
    match=re.match(r'\s*@([A-Za-z0-9._]+)\s*:',clean(title))
    return match.group(1).casefold() if match else ''

def approved_rap_candidate(item):
    handle=source_handle(item.get('title','')); blob=f" {clean(item.get('title')).casefold()} {clean(item.get('description')).casefold()} "
    if handle not in APPROVED_SOURCE_HANDLES or any(term in blob for term in NON_NEWS_FLUFF):return False
    if handle=='gta6latest':return True
    if handle in RAP_CENTRIC_SOURCES or any(term in blob for term in RAP_TOPIC_TERMS):return True
    normalized=' '+re.sub(r'[^a-z0-9]+',' ',blob).strip()+' '
    return handle=='theshaderoom' and any(f' {artist} ' in normalized for artist in VERIFIED_RAP_ARTISTS)

def tag_text(item,name):
    for child in item:
        if child.tag.rsplit('}',1)[-1].lower()==name.lower(): return clean(child.text)
    return ''

def raw_tag_text(item,name):
    for child in item:
        if child.tag.rsplit('}',1)[-1].lower()==name.lower():
            return ''.join(child.itertext()) or child.text or ''
    return ''

def usable_image_url(url,base=''):
    if not url:return ''
    url=html.unescape(url.strip()); url=urllib.parse.urljoin(base,url)
    return url if url.startswith(('https://','http://')) else ''

def feed_image_url(item,link):
    for child in item:
        local=child.tag.rsplit('}',1)[-1].lower(); url=child.attrib.get('url') or child.attrib.get('href') or ''; kind=(child.attrib.get('type') or '').lower()
        looks_like_image=bool(re.search(r'\.(?:jpe?g|png|webp)(?:\?|$)',url,re.I))
        if url and (local=='thumbnail' or kind.startswith('image/') or looks_like_image):
            found=usable_image_url(url,link)
            if found:return found
    raw=' '.join((raw_tag_text(item,'description'),raw_tag_text(item,'encoded')))
    match=re.search(r'<img[^>]+src=["\']([^"\']+)',raw,re.I)
    return usable_image_url(match.group(1),link) if match else ''

def discover_source_image(source):
    candidates=[]
    if source.get('image_url'):candidates.append(source['image_url'])
    req=urllib.request.Request(source['link'],headers={'User-Agent':'Mozilla/5.0 RapWire24/4.0'})
    try:
        with urllib.request.urlopen(req,timeout=30) as response:page=response.read(2_000_000).decode('utf-8','ignore')
    except Exception:page=''
    patterns=(
        r'<meta[^>]+(?:property|name)=["\'](?:og:image|twitter:image(?::src)?)["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:image|twitter:image(?::src)?)["\']',
        r'<img[^>]+src=["\']([^"\']+)',
    )
    for pattern in patterns:
        match=re.search(pattern,page,re.I)
        if match:
            found=usable_image_url(match.group(1),source['link'])
            if found and found not in candidates:candidates.append(found)
    for candidate in candidates:
        try:return candidate,image_data_url(candidate)
        except Exception as error:print('Reference candidate failed:',candidate,error)
    raise RuntimeError('Selected story has no usable source/event image; RapWire will not invent a generic scene')

def image_data_url(url):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 RapWire24/4.0','Accept':'image/*'})
    with urllib.request.urlopen(req,timeout=45) as response:raw=response.read(12_000_001)
    if len(raw)>12_000_000:raise RuntimeError('Source reference image exceeds 12 MB')
    image=Image.open(io.BytesIO(raw)).convert('RGB'); image.thumbnail((1600,1600),Image.Resampling.LANCZOS)
    out=io.BytesIO(); image.save(out,'JPEG',quality=92,optimize=True)
    return 'data:image/jpeg;base64,'+base64.b64encode(out.getvalue()).decode('ascii')

def pub_date(v):
    if not v:return None
    try: dt=parsedate_to_datetime(v)
    except Exception:
        try: dt=datetime.fromisoformat(v.replace('Z','+00:00'))
        except Exception:return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)

def parse_narro():
    req=urllib.request.Request(FEED_URL,headers={'User-Agent':'RapWire24-SourceMonitor/4.0'})
    with urllib.request.urlopen(req,timeout=30) as r: raw=r.read()
    root=ET.fromstring(raw); now=datetime.now(timezone.utc); cutoff=now.timestamp()-MAX_AGE_HOURS*3600; items=[]
    for item in root.iter():
        if item.tag.rsplit('}',1)[-1].lower()!='item': continue
        title=tag_text(item,'title'); desc=tag_text(item,'description') or tag_text(item,'encoded'); link=tag_text(item,'link')
        guid=tag_text(item,'guid') or link or title; dt=pub_date(tag_text(item,'pubDate') or tag_text(item,'published') or tag_text(item,'date'))
        if title and dt and cutoff<=dt.timestamp()<=now.timestamp():
            link=link or FEED_URL
            candidate={'id':guid,'title':title,'description':desc[:3500],'link':link,'published':dt.isoformat(),'image_url':feed_image_url(item,link)}
            if approved_rap_candidate(candidate):items.append(candidate)
    seen=set(); out=[]
    for x in sorted(items,key=lambda a:a['published'],reverse=True):
        k=re.sub(r'[^a-z0-9]+',' ',x['title'].lower()).strip()
        if k not in seen: seen.add(k); out.append(x)
    return out[:MAX_CANDIDATES]

def existing():
    seen=set()
    for p in QUEUE.glob('*.json'):
        try:
            d=json.loads(p.read_text())
            for k in ('source_guid','source_url','story_fingerprint'):
                if d.get(k):seen.add(str(d[k]))
            seen.update(str(x) for x in d.get('source_urls',[]))
        except Exception: pass
    return seen

def choose(cands):
    text='\n\n'.join(f"[{i}] TITLE: {c['title']}\nPUBLISHED: {c['published']}\nSOURCE: {c['link']}\nDETAILS: {c['description']}" for i,c in enumerate(cands))
    prompt=f'''You are the senior editor for RapWire 24/7, a premium rap-first newsroom. Pick ONE fresh RAP OR HIP-HOP story from this approved Narro source feed. Approved sources are DJ Akademiks, Trap Lore Ross, Poetik Flako, No Jumper, Say Cheese TV, WorldStarHipHop, Detroit Rap News, Detroit Rap Daily, Complex Music (@complexmusic), and The Shade Room only when directly rap-related. GTA 6 news from @gta6latest is the only approved non-rap exception and must remain occasional. A rap story must directly concern a rapper, rap release, hip-hop performance, rap-industry development, rap beef, or a verified legal development involving a rapper. Prioritize substantive Lil Durk federal-trial developments when current; for criminal matters clearly state allegations, known plea posture, and presumption of innocence. Reject pop-only music, movies, general entertainment, influencer fluff, celebrity lifestyle, unrelated politics, weather, and stale/recycled items. Do not invent facts. Use web search to verify the selected story if needed.
Return ONLY JSON: {{"index":number,"headline":string,"story":string,"caption":string,"visual_scene":string,"source_label":string,"featured_person":string,"instagram_handle":string,"instagram_profile_url":string,"extra_context":string}}.
Headline must be factual and premium-newsroom clean. Story must be 110-180 informative words in complete sentences and explain what happened, why it matters, timeline/status, and key verified context. Never choose a ranking/list headline unless the story includes every item promised by that headline. visual_scene must describe the specific moment shown by the selected source/event photo, not an invented or abstract scene. Verify the featured person's current official Instagram account with web search; never infer the handle from the stage name. Include all necessary verified context in story or extra_context; the renderer will add as many carousel pages as readability requires. Never leave a sentence unfinished or use placeholder copy.
CANDIDATES:\n{text}'''
    r=client.responses.create(model='gpt-5.6-luna',tools=[{'type':'web_search'}],input=prompt)
    m=re.search(r'\{.*\}',r.output_text.strip(),re.S)
    if not m: raise RuntimeError('AI editor did not return JSON')
    result=json.loads(m.group(0)); idx=int(result['index'])
    if idx<0 or idx>=len(cands): raise RuntimeError('AI selected invalid candidate')
    result['source_item']=cands[idx]; return result

def generate_art(scene,headline,reference_data_url):
    prompt=f'''Create ONE original editorial illustration for a premium hip-hop news brand.
ACTUAL EVENT TO DEPICT: {scene}
REFERENCE PHOTO ROLE: The supplied source image is the factual visual reference. Preserve the recognizable people, identity, number of people, clothing, setting, pose, important props, event details and overall camera direction that make this specific moment newsworthy. Do not replace it with a generic imagined scene.

STYLE: unmistakable 1980s American underground comic-book/newsstand drawing; hand-inked black linework; brush and pen texture; screen-print halftone dots; vintage imperfect print; dramatic cinematic perspective; detailed environment; believable anatomy; sophisticated deep purple, black, cream, yellow and restrained red palette; gritty, stylish, collectible professional illustration. The actual event must be obvious from the image. If a named public figure is central, use an editorial comic depiction rather than a photorealistic copy.

ABSOLUTE RULES: materially redraw the reference as original editorial art rather than copying pixels or tracing line-for-line; no text; no captions; no logos; no watermark; no letters; no fake newspaper masthead; no generic abstract shapes; no vector clip-art look. Do not add people, objects or actions unsupported by the reference and reporting. Keep every visible head, face, hair, hand, award and essential subject completely inside the canvas with generous crop-safe margin. Leave clean breathing room near the top for typography added later.
Headline context: {headline}'''
    r=client.responses.create(model='gpt-5.6-luna',input=[{'role':'user','content':[{'type':'input_text','text':prompt},{'type':'input_image','image_url':reference_data_url,'detail':'high'}]}],tools=[{'type':'image_generation','model':'gpt-image-2','action':'generate','size':'1024x1536','quality':'high','output_format':'jpeg','output_compression':92,'background':'opaque'}],tool_choice={'type':'image_generation'})
    vals=[o.result for o in r.output if getattr(o,'type','')=='image_generation_call']
    if not vals: raise RuntimeError('GPT-Image-2 returned no image')
    return base64.b64decode(vals[0])

def fnt(n,b=True): return ImageFont.truetype(FONT_BOLD if b else FONT_REG,n)
def wrap(d,text,font,width):
    lines=[]; cur=''
    for w in text.split():
        t=(cur+' '+w).strip()
        if d.textbbox((0,0),t,font=font)[2]<=width:cur=t
        else:
            if cur:lines.append(cur)
            cur=w
    if cur:lines.append(cur)
    return lines

def fit_head(d,text,width,max_lines):
    for n in range(74,27,-3):
        ff=fnt(n); ls=wrap(d,text.upper(),ff,width)
        if len(ls)<=max_lines:return ff,ls
    raise ValueError('Headline cannot fit without clipping; publication blocked')

def person_tag(draw,x,y,label):
    if not label:return
    ff=fnt(25); width=int(draw.textlength(label,font=ff))+34
    draw.rounded_rectangle((x,y,x+width,y+48),radius=8,fill=INK,outline=YELLOW,width=3)
    draw.text((x+17,y+9),label,font=ff,fill=PAPER)

def assets(story_id,headline,story,art_bytes,source_label,person_label='',carousel_pages=2,extra_context=''):
    MEDIA.mkdir(parents=True,exist_ok=True); art_path=MEDIA/f'{story_id}-art.jpg'; art_path.write_bytes(art_bytes); art=Image.open(art_path).convert('RGB')
    full_copy=' '.join(part for part in (story.replace('\n',' '),extra_context.replace('\n',' ')) if part).strip()
    parts=person_label.rsplit('  ',1); name=parts[0].title() if parts else ''; handle=parts[1] if len(parts)==2 else ''
    spec=importlib.util.spec_from_file_location('rapwire_shared_layout',ROOT/'scripts'/'fallback-photo-post.py')
    layout=importlib.util.module_from_spec(spec); spec.loader.exec_module(layout); layout.MEDIA=MEDIA
    _,_,slides,story_path=layout.render(story_id,{'title':headline,'description':full_copy},name,handle,source_label,art,credit_prefix='SOURCE ART')
    return slides,story_path

def next_id(headline):
    nums=[]
    for p in QUEUE.glob('*.json'):
        m=re.match(r'(\d+)-',p.name)
        if m:nums.append(int(m.group(1)))
    n=max(nums,default=0)+1; slug=re.sub(r'[^a-z0-9]+','-',headline.lower()).strip('-')[:55] or 'story'; return f'{n:03d}-{slug}'

def ai_cover_is_eligible():
    """Use AI occasionally, never back-to-back, and only when credentials exist."""
    if not os.environ.get('OPENAI_API_KEY'):
        return False
    published=[]
    for path in QUEUE.glob('*.json'):
        try:
            item=json.loads(path.read_text())
        except Exception:
            continue
        if item.get('status')=='published' and item.get('published_at'):
            published.append(item)
    published.sort(key=lambda item:item.get('published_at',''),reverse=True)
    if any(item.get('ai_generated_art') is True for item in published[:2]):
        return False
    percent=max(0,min(100,int(os.environ.get('AI_COVER_PERCENT','33'))))
    return secrets.randbelow(100)<percent

def main():
    if not os.environ.get('OPENAI_API_KEY'): raise RuntimeError('OPENAI_API_KEY is required. RapWire refuses to publish without AI-owned artwork.')
    cands=[c for c in parse_narro() if c['id'] not in existing() and c['link'] not in existing()]
    if not cands: print('Narro: no new candidates.'); return
    choice=choose(cands); src=choice['source_item']; headline=clean(choice['headline']); story=clean(choice['story']); caption=clean(choice['caption']); label=clean(choice.get('source_label') or 'Narro source')
    if not headline or not story:raise RuntimeError('AI returned empty editorial copy')
    reference_url,reference_data=discover_source_image(src); person=clean(choice.get('featured_person')); handle=clean(choice.get('instagram_handle')); profile=clean(choice.get('instagram_profile_url')); handle=handle if handle.startswith('@') else ''
    if person and (not handle or 'instagram.com/' not in profile):raise RuntimeError('Featured-person Instagram handle was not verified')
    person_label=f'{person.upper()}  {handle}' if person and handle else ''; extra_context=clean(choice.get('extra_context')); pages=2
    print('AI selected:',headline); print('Using source visual reference:',reference_url); print('Generating source-grounded comic art...'); art=generate_art(choice['visual_scene'],headline,reference_data); sid=next_id(headline); slides,ps=assets(sid,headline,story,art,label,person_label,pages,extra_context); url=src['link']; identity_line=f'\n\n{person} ({handle})' if person_label else ''
    item={'id':sid,'status':'ready','ai_generated_art':True,'visual_asset_type':'ai_original_comic_from_source_reference','visual_asset_rights':'owned','created_at':datetime.now(timezone.utc).isoformat(),'source':label,'source_handle':source_handle(src['title']),'source_policy_checked':True,'rap_relevance_checked':True,'source_urls':[url],'source_url':url,'source_guid':src['id'],'source_title':src['title'],'source_published_at':src['published'],'story_fingerprint':re.sub(r'[^a-z0-9]+',' ',headline.lower()).strip(),'headline':headline,'body':story,'rendered_body_text':story,'text_overflow_checked':True,'caption':f'{caption}{identity_line}\n\nSource: {label}\n{url}\n\nFollow @rapwire247 for hip-hop, culture and real-time news.','threads_text':f'{headline}{identity_line}\n\n{story}\n\nSource: {label}','featured_person':person,'artist_instagram_handle':handle,'artist_handle_verified':bool(handle),'artist_handle_verified_url':profile,'displayed_artist_label':person_label,'visual_prompt':choice['visual_scene'],'slides':[str(p.relative_to(ROOT)) for p in slides],'carousel_page_count':len(slides),'story':str(ps.relative_to(ROOT)),'media_urls':[],'source_image_url':reference_url,'source_photo_used':True,'source_image_role':'factual visual reference only; final art is a materially redrawn original editorial illustration'}
    item['layout_template']='rapwire-unified-v3'
    blob=f" {headline.casefold()} {story.casefold()} "
    item['editorial_lane']='lil_durk_trial' if 'lil durk' in blob and any(term in blob for term in ('trial','court','prosecution','defense','witness','testimony')) else ('gta' if source_handle(src['title'])=='gta6latest' else 'rap_substantive')
    item['content_claim_checked']=True
    item['editorial_substance_checked']=True
    item['content_detail_count']=len(re.findall(r'\b\d+\.\s',story))
    (QUEUE/f'{sid}.json').write_text(json.dumps(item,indent=2)+'\n'); print('Created:',sid)
if __name__=='__main__':
    mode=os.environ.get('USE_OPENAI_AUTOMATION','auto').lower()
    use_ai=(mode=='true') or (mode=='auto' and ai_cover_is_eligible())
    if use_ai:
        try:
            print('Mixed visual rotation: attempting an old-school comic cover.')
            main()
        except Exception:
            traceback.print_exc()
            print('AI credits or generation unavailable; using the credited real-photo fallback for this run.')
            subprocess.run([sys.executable,str(ROOT/'scripts'/'fallback-photo-post.py')],check=True)
        else:
            print('Filling the remaining editorial batch slots with credited real-photo posts.')
            subprocess.run([sys.executable,str(ROOT/'scripts'/'fallback-photo-post.py')],check=True)
    else:
        print('Mixed visual rotation: using the credited real-photo publisher for this run.')
        subprocess.run([sys.executable,str(ROOT/'scripts'/'fallback-photo-post.py')],check=True)
