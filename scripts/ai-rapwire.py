#!/usr/bin/env python3
import base64, html, json, os, re, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
from openai import OpenAI

ROOT=Path(__file__).resolve().parents[1]; QUEUE=ROOT/'queue'; MEDIA=ROOT/'media'
FEED_URL=os.environ.get('NARRO_RSS_URL','https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f')
MAX_CANDIDATES=int(os.environ.get('MAX_NEW_ITEMS','12')); MAX_AGE_HOURS=int(os.environ.get('MAX_SOURCE_AGE_HOURS','24'))
FONT_BOLD='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; FONT_REG='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
INK=(19,17,27); PAPER=(247,246,239); YELLOW=(248,204,47); PURPLE=(67,40,98); RED=(135,25,48)
client=OpenAI(api_key=os.environ.get('OPENAI_API_KEY'))

def clean(v):
    v=html.unescape(v or ''); v=re.sub(r'<[^>]+>',' ',v); return re.sub(r'\s+',' ',v).strip()

def tag_text(item,name):
    for child in item:
        if child.tag.rsplit('}',1)[-1].lower()==name.lower(): return clean(child.text)
    return ''

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
        if title and dt and cutoff<=dt.timestamp()<=now.timestamp(): items.append({'id':guid,'title':title,'description':desc[:3500],'link':link or FEED_URL,'published':dt.isoformat()})
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
    prompt=f'''You are the senior editor for RapWire 24/7. Pick ONE fresh story from this Narro feed for the next Instagram post. Prioritize major hip-hop/rap artist news, music, beefs, legal/crime stories involving hip-hop, viral culture, Detroit/Atlanta/LA/NY hip-hop, major entertainment, and visually strong events. Reject generic fluff, unrelated politics, weather, stale/recycled items, and stories with no meaningful connection to hip-hop/culture. Do not invent facts. Use web search to verify the selected story if needed.
Return ONLY JSON: {{"index":number,"headline":string,"story":string,"caption":string,"visual_scene":string,"source_label":string}}.
Headline max 95 chars and factual. Story must clearly explain what happened in 2-4 short paragraphs. visual_scene must describe a concrete scene showing the actual event, not an abstract concept.
CANDIDATES:\n{text}'''
    r=client.responses.create(model='gpt-5.6-luna',tools=[{'type':'web_search'}],input=prompt)
    m=re.search(r'\{.*\}',r.output_text.strip(),re.S)
    if not m: raise RuntimeError('AI editor did not return JSON')
    result=json.loads(m.group(0)); idx=int(result['index'])
    if idx<0 or idx>=len(cands): raise RuntimeError('AI selected invalid candidate')
    result['source_item']=cands[idx]; return result

def generate_art(scene,headline):
    prompt=f'''Create ONE original editorial illustration for a premium hip-hop news brand.
ACTUAL EVENT TO DEPICT: {scene}

STYLE: unmistakable 1980s American underground comic-book/newsstand drawing; hand-inked black linework; brush and pen texture; screen-print halftone dots; vintage imperfect print; dramatic cinematic perspective; detailed environment; believable anatomy; sophisticated deep purple, black, cream, yellow and restrained red palette; gritty, stylish, collectible professional illustration. The actual event must be obvious from the image. If a named public figure is central, use an editorial comic depiction rather than a photorealistic copy.

ABSOLUTE RULES: original artwork only; never reproduce or trace a source photo/blog image/screenshot/existing artwork; no text; no captions; no logos; no watermark; no letters; no fake newspaper masthead; no generic abstract shapes; no vector clip-art look. Leave clean breathing room near the top for typography added later.
Headline context: {headline}'''
    r=client.responses.create(model='gpt-5.6-luna',input=prompt,tools=[{'type':'image_generation','model':'gpt-image-2','action':'generate','size':'1024x1536','quality':'high','output_format':'jpeg','output_compression':92,'background':'opaque'}],tool_choice={'type':'image_generation'})
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
    for n in range(74,39,-3):
        ff=fnt(n); ls=wrap(d,text.upper(),ff,width)
        if len(ls)<=max_lines:return ff,ls
    ff=fnt(40); return ff,wrap(d,text.upper(),ff,width)[:max_lines]

def assets(story_id,headline,story,art_bytes,source_label):
    MEDIA.mkdir(parents=True,exist_ok=True); art_path=MEDIA/f'{story_id}-art.jpg'; art_path.write_bytes(art_bytes); art=Image.open(art_path).convert('RGB')
    W,H=1080,1350; s1=Image.new('RGB',(W,H),INK); d=ImageDraw.Draw(s1); hero=ImageOps.fit(art,(1000,800),method=Image.Resampling.LANCZOS,centering=(.5,.42)); s1.paste(hero,(40,40))
    d.rectangle((40,40,300,100),fill=YELLOW); d.text((58,52),'RAPWIRE',font=fnt(32),fill=INK); d.rectangle((40,875,1040,1310),fill=PURPLE)
    hf,ls=fit_head(d,headline,900,4); y=915
    for line in ls:d.text((72,y),line,font=hf,fill=PAPER); y+=hf.size+9
    d.text((72,1260),f'{source_label.upper()}  •  RAPWIRE',font=fnt(25),fill=YELLOW); p1=MEDIA/f'{story_id}-slide-1.jpg'; s1.save(p1,quality=94,optimize=True)
    s2=Image.new('RGB',(W,H),PAPER); d=ImageDraw.Draw(s2); d.rectangle((0,0,W,18),fill=YELLOW); d.text((58,55),'RAPWIRE',font=fnt(46),fill=INK); d.text((58,135),'WHAT HAPPENED',font=fnt(38),fill=RED); d.rectangle((58,195,1022,201),fill=INK)
    ls=wrap(d,story.replace('\n',' '),fnt(38,False),900); y=245
    for line in ls[:20]:d.text((70,y),line,font=fnt(38,False),fill=INK); y+=51
    d.rectangle((58,1195,1022,1201),fill=YELLOW); d.text((58,1235),f'SOURCE: {source_label}',font=fnt(27),fill=INK); d.text((58,1285),'HIP-HOP  •  CULTURE  •  REAL-TIME',font=fnt(25),fill=RED); p2=MEDIA/f'{story_id}-slide-2.jpg'; s2.save(p2,quality=94,optimize=True)
    SW,SH=1080,1920; st=Image.new('RGB',(SW,SH),INK); sd=ImageDraw.Draw(st); sa=ImageOps.fit(art,(980,1040),method=Image.Resampling.LANCZOS,centering=(.5,.4)); st.paste(sa,(50,50)); sd.rectangle((50,50,290,102),fill=YELLOW); sd.text((68,60),'RAPWIRE',font=fnt(30),fill=INK); sd.rectangle((50,1135,1030,1860),fill=PURPLE); sf,sl=fit_head(sd,headline,880,5); y=1185
    for line in sl:sd.text((78,y),line,font=sf,fill=PAPER); y+=sf.size+8
    sd.text((78,1800),'RAPWIRE  •  HIP-HOP / CULTURE / NEWS',font=fnt(25),fill=YELLOW); ps=MEDIA/f'{story_id}-story.jpg'; st.save(ps,quality=94,optimize=True); return p1,p2,ps

def next_id(headline):
    nums=[]
    for p in QUEUE.glob('*.json'):
        m=re.match(r'(\d+)-',p.name)
        if m:nums.append(int(m.group(1)))
    n=max(nums,default=0)+1; slug=re.sub(r'[^a-z0-9]+','-',headline.lower()).strip('-')[:55] or 'story'; return f'{n:03d}-{slug}'

def main():
    if not os.environ.get('OPENAI_API_KEY'): raise RuntimeError('OPENAI_API_KEY is required. RapWire refuses to publish without AI-owned artwork.')
    cands=[c for c in parse_narro() if c['id'] not in existing() and c['link'] not in existing()]
    if not cands: print('Narro: no new candidates.'); return
    choice=choose(cands); src=choice['source_item']; headline=clean(choice['headline']); story=clean(choice['story']); caption=clean(choice['caption']); label=clean(choice.get('source_label') or 'Narro source')
    if not headline or not story:raise RuntimeError('AI returned empty editorial copy')
    print('AI selected:',headline); print('Generating original comic art...'); art=generate_art(choice['visual_scene'],headline); sid=next_id(headline); p1,p2,ps=assets(sid,headline,story,art,label); url=src['link']
    item={'id':sid,'status':'ready','ai_generated_art':True,'visual_asset_type':'ai_original_comic','visual_asset_rights':'owned','created_at':datetime.now(timezone.utc).isoformat(),'source':label,'source_urls':[url],'source_url':url,'source_guid':src['id'],'source_title':src['title'],'source_published_at':src['published'],'story_fingerprint':re.sub(r'[^a-z0-9]+',' ',headline.lower()).strip(),'headline':headline,'body':story,'caption':f'{caption}\n\nSource: {label}\n{url}\n\nFollow @rapwire247 for hip-hop, culture and real-time news.','threads_text':f'{headline}\n\n{story}\n\nSource: {label}','visual_prompt':choice['visual_scene'],'slides':[str(p1.relative_to(ROOT)),str(p2.relative_to(ROOT))],'story':str(ps.relative_to(ROOT)),'media_urls':[],'source_image_url':'','source_photo_used':False}
    (QUEUE/f'{sid}.json').write_text(json.dumps(item,indent=2)+'\n'); print('Created:',sid)
if __name__=='__main__':main()
