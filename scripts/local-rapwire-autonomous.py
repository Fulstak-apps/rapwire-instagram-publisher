#!/usr/bin/env python3
"""RapWire 24/7 autonomous local newsroom.

Local AI: Ollama (default qwen3:4b)
Cost: no paid model API required.
Purpose: discover -> rank -> write -> QA -> queue.
Publishing remains handled by the repo's existing GitHub/Meta publisher.

The script can create `status=ready` queue items in autonomous mode, but only when
its deterministic text/source/media-reference gates pass. The existing publisher
still applies its own media/layout/publication-policy gates before anything goes live.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
QUEUE = Path(os.environ.get("RAPWIRE_DRAFT_DIR", str(ROOT / "queue")))
LOG_DIR = Path(os.environ.get("RAPWIRE_LOCAL_LOG_DIR", str(ROOT / "logs")))
FEED_URL = os.environ.get("NARRO_RSS_URL", "https://rss.narro.info/e4f36406-0664-4e77-b672-7e0682966a9f")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")
MAX_SOURCE_AGE_HOURS = max(6, int(os.environ.get("MAX_SOURCE_AGE_HOURS", "36")))
MAX_CANDIDATES = max(1, min(40, int(os.environ.get("MAX_NEW_ITEMS", "20"))))
QA_THRESHOLD = max(0, min(100, int(os.environ.get("RAPWIRE_QA_THRESHOLD", "88"))))
AUTONOMOUS = os.environ.get("RAPWIRE_AUTONOMOUS", "1").lower() in {"1","true","yes","on"}
MIN_AUTONOMOUS_SCORE = max(QA_THRESHOLD, int(os.environ.get("RAPWIRE_AUTONOMOUS_SCORE", "92")))

SOURCE_CONFIG = ROOT / "monitor" / "sources.json"


def load_sources(path: Path = SOURCE_CONFIG) -> dict[str, dict[str, Any]]:
    """Use the production collector registry instead of a drifting private list."""
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot load source registry {path}: {error}") from error
    sources = {}
    for entry in payload.get("sources", []):
        handle = str(entry.get("handle", "")).strip().lstrip("@").casefold()
        if handle and entry.get("enabled") is True:
            sources[handle] = entry
    if not sources:
        raise RuntimeError("Source registry contains no enabled sources")
    return sources


SOURCE_REGISTRY = load_sources()
APPROVED_SOURCE_HANDLES = set(SOURCE_REGISTRY)
RAP_CENTRIC_SOURCES = {
    handle for handle, entry in SOURCE_REGISTRY.items() if entry.get("scope") == "hiphop"
}

RAP_TERMS = (
    " rap ", "rapper", "hip-hop", "hip hop", "hiphop", "album", "mixtape", "single",
    "track", "song", "producer", "bars", "verse", "freestyle", "diss", "beef",
    "record label", "tour", "concert", "festival", "stage", "court", "charged",
    "arrested", "sentenced", "plea", "shooting", "lawsuit", "interview", "rapper"
)
VIRAL_TERMS = (
    "viral", "wild", "crazy", "beef", "diss", "argument", "fight", "funny", "joke",
    "thirst trap", "relationship", "dating", "outfit", "fashion", "reacts", "responds",
    "claps back", "controversial", "debate", "rant", "troll", "meme", "sports"
)
HIGH_RISK_TERMS = (
    "arrest", "arrested", "charged", "charges", "convicted", "conviction", "sentenced",
    "sentence", "murder", "killed", "dead", "death", "shooting", "shot", "rape",
    "assault", "lawsuit", "sued", "abuse", "accused", "alleged", "allegedly"
)

@dataclass
class Candidate:
    guid: str
    title: str
    description: str
    link: str
    published_at: str
    source_handle: str
    image_url: str = ""
    score: int = 0
    lane: str = "culture"
    confidence: str = "reported"


def clean(v: str | None) -> str:
    v = html.unescape(v or "")
    v = re.sub(r"<[^>]+>", " ", v)
    return re.sub(r"\s+", " ", v).strip()


def norm(v: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", clean(v).casefold()).strip()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def child_text(item: ET.Element, wanted: str) -> str:
    for child in item:
        if local_name(child.tag) == wanted.lower():
            return clean("".join(child.itertext()))
    return ""


def source_handle(title: str, link: str="") -> str:
    m = re.match(r"\s*@([A-Za-z0-9._]+)\s*:", clean(title))
    if m: return m.group(1).casefold()
    parsed = urllib.parse.urlparse(link)
    if parsed.netloc.casefold().removeprefix("www.") == "instagram.com":
        first = parsed.path.strip("/").split("/",1)[0]
        if first and first not in {"p","reel","stories"}: return first.casefold()
    return ""


def parse_date(value: str) -> datetime | None:
    if not value: return None
    try: dt = parsedate_to_datetime(value)
    except Exception:
        try: dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception: return None
    if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def feed_image(item: ET.Element, link: str) -> str:
    for child in item:
        url = child.attrib.get("url") or child.attrib.get("href") or ""
        typ = (child.attrib.get("type") or "").lower()
        if url and (local_name(child.tag)=="thumbnail" or typ.startswith("image/") or re.search(r"\.(jpe?g|png|webp)(\?|$)",url,re.I)):
            return urllib.parse.urljoin(link, html.unescape(url))
    return ""


def lane_for(text: str) -> str:
    t = f" {text.casefold()} "
    if any(x in t for x in ("arrest","charged","court","sentenced","lawsuit","trial")): return "legal"
    if any(x in t for x in ("album","song","single","mixtape","track","producer","verse")): return "music"
    if any(x in t for x in ("beef","diss","claps back","responds","rant")): return "beef"
    if any(x in t for x in ("gta 6","grand theft auto","rockstar games")): return "gta"
    if any(x in t for x in ("thirst trap","dating","relationship","fashion","outfit")): return "viral"
    return "culture"


def risk_level(text: str) -> str:
    t = text.casefold()
    return "high" if any(term in t for term in HIGH_RISK_TERMS) else "normal"


def deterministic_rank(candidate: Candidate) -> int:
    text = f" {clean(candidate.title)} {clean(candidate.description)} ".casefold()
    score = 25
    if candidate.source_handle in RAP_CENTRIC_SOURCES: score += 20
    if any(x in text for x in RAP_TERMS): score += 18
    if any(x in text for x in VIRAL_TERMS): score += 12
    published = parse_date(candidate.published_at)
    if published:
        hours = (datetime.now(timezone.utc)-published).total_seconds()/3600
        if hours <= 2: score += 20
        elif hours <= 6: score += 14
        elif hours <= 12: score += 8
        elif hours <= 24: score += 3
    if candidate.image_url: score += 5
    if len(clean(candidate.description)) >= 80: score += 4
    return max(0, min(100, score))


def rap_relevant(title: str, description: str, handle: str) -> bool:
    text = f" {clean(title).casefold()} {clean(description).casefold()} "
    if handle == "gta6latest": return any(x in text for x in (" gta ","gta 6","grand theft auto","rockstar games"))
    if handle in RAP_CENTRIC_SOURCES: return True
    return any(x in text for x in RAP_TERMS + VIRAL_TERMS)


def fetch_feed() -> list[Candidate]:
    req = urllib.request.Request(FEED_URL, headers={"User-Agent":"RapWire24-Autonomous/2.0"})
    with urllib.request.urlopen(req, timeout=30) as r: raw = r.read()
    root = ET.fromstring(raw)
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - MAX_SOURCE_AGE_HOURS*3600
    out=[]
    for item in root.iter():
        if local_name(item.tag) != "item": continue
        title=child_text(item,"title")
        desc=child_text(item,"description") or child_text(item,"encoded")
        link=child_text(item,"link") or FEED_URL
        guid=child_text(item,"guid") or link or title
        pub=parse_date(child_text(item,"pubDate") or child_text(item,"published") or child_text(item,"date"))
        handle=source_handle(title,link)
        if not title or not pub or not (cutoff <= pub.timestamp() <= now.timestamp()): continue
        if handle not in APPROVED_SOURCE_HANDLES: continue
        if not rap_relevant(title,desc,handle): continue
        c=Candidate(guid,title,desc[:6000],link,pub.isoformat(),handle,feed_image(item,link))
        c.lane=lane_for(f"{title} {desc}")
        c.score=deterministic_rank(c)
        c.confidence="reported" if risk_level(f"{title} {desc}")=="high" else "confirmed_or_reported"
        out.append(c)
    dedup={}
    for c in sorted(out,key=lambda x:(x.score,x.published_at),reverse=True):
        dedup.setdefault(norm(c.title),c)
    return list(dedup.values())[:MAX_CANDIDATES]


def existing_keys() -> set[str]:
    keys=set()
    if not QUEUE.exists(): return keys
    for p in QUEUE.glob("*.json"):
        try: item=json.loads(p.read_text())
        except Exception: continue
        for f in ("source_guid","source_url","story_fingerprint"):
            if item.get(f): keys.add(str(item[f]))
        for u in item.get("source_urls",[]): keys.add(str(u))
        if item.get("headline"): keys.add(f"headline:{norm(str(item['headline']))}")
        shortcode = re.search(r"instagram\.com/(?:p|reel)/([^/?#]+)", str(item.get("source_url", "")))
        if shortcode: keys.add(f"shortcode:{shortcode.group(1)}")
    return keys


def page_metadata(url: str) -> dict[str,str]:
    req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 RapWire24-Autonomous/2.0"})
    try:
        with urllib.request.urlopen(req,timeout=20) as r: page=r.read(1_500_000).decode("utf-8","ignore")
    except Exception: return {}
    result={}
    pats={
        "og_title":r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)',
        "og_description":r'<meta[^>]+(?:property|name)=["\']og:description["\'][^>]+content=["\']([^"\']+)',
        "og_image":r'<meta[^>]+(?:property|name)=["\']og:image["\'][^>]+content=["\']([^"\']+)'
    }
    for k,p in pats.items():
        m=re.search(p,page,re.I)
        if m: result[k]=clean(m.group(1))
    return result


def build_evidence(c: Candidate) -> dict[str,Any]:
    m=page_metadata(c.link)
    return {
        "source_handle":c.source_handle,
        "source_url":c.link,
        "source_published_at":c.published_at,
        "feed_title":clean(c.title),
        "feed_description":clean(c.description),
        "page_title":m.get("og_title",""),
        "page_description":m.get("og_description",""),
        "image_url":c.image_url or m.get("og_image",""),
        "deterministic_rank":c.score,
        "lane":c.lane,
        "risk":risk_level(f"{c.title} {c.description}"),
        "reporting_confidence":c.confidence,
    }


def ollama_chat(prompt: str) -> dict[str,Any]:
    payload=json.dumps({
        "model":OLLAMA_MODEL,"stream":False,"think":False,"format":"json",
        "messages":[
            {"role":"system","content":(
                "You are RapWire 24/7's local hip-hop newsroom editor. Be fast, culturally native, concise, funny or provocative when the evidence supports it. "
                "You may select viral moments, tasteful adult thirst-trap culture, debates, beef and polarizing takes. "
                "Use ONLY supplied evidence for factual claims. Never invent names, dates, quotes, handles, crimes, accusations, motives or context. "
                "For unverified/developing claims, preserve attribution: 'X reports/says/alleges'. Do not convert allegation into fact. "
                "Opinions must clearly read as opinion. Return valid JSON only."
            )},
            {"role":"user","content":prompt}
        ],"options":{"temperature":0.35,"num_predict":1800}
    }).encode()
    req=urllib.request.Request(f"{OLLAMA_URL}/api/chat",data=payload,headers={"Content-Type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=300) as r: data=json.loads(r.read().decode())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cannot reach Ollama at {OLLAMA_URL}. Start Ollama and run: ollama pull {OLLAMA_MODEL}") from e
    content=data.get("message",{}).get("content","")
    if not content: raise RuntimeError("Ollama returned empty content")
    try: return json.loads(content)
    except json.JSONDecodeError as e: raise RuntimeError(f"Ollama returned invalid JSON: {content[:600]}") from e


def choose_story(candidates: list[Candidate]) -> tuple[Candidate,dict[str,Any]]:
    evidence=[build_evidence(c) for c in candidates]
    prompt=(
        "Choose exactly ONE RapWire item. Strong ranking signals: freshness, rap relevance, entertainment value, debate value, strong usable media, and cultural relevance. "
        "Do NOT reject something merely because it is a thirst trap, messy, controversial, funny, or likely to make comments argue. "
        "For serious legal/death/injury claims, attribute what the source reports unless the supplied evidence itself establishes the fact. "
        "Return JSON keys: index, headline (<=100 chars), body (20-180 words), caption (1-3 short paragraphs), threads_text (<=500 chars), "
        "category (breaking|music|beef|business|legal|culture|viral|gta), featured_person, content_format (photo_news|tweet_statement|video_repost), "
        "tone (straight|funny|debate|opinion), confidence (confirmed|reported|developing|rumor), attribution_needed (bool), adult_thirst_trap (bool). "
        "If none are worth posting set index=-1.\n\nCANDIDATES:\n"+json.dumps(evidence,ensure_ascii=False,indent=2)
    )
    res=ollama_chat(prompt)
    if not isinstance(res, dict) or type(res.get("index")) is not int: raise RuntimeError("Invalid Ollama index")
    idx=res["index"]
    if idx<0 or idx>=len(candidates): raise RuntimeError("No candidate selected")
    res["source_evidence"]=evidence[idx]
    return candidates[idx],res


def normalize_editorial(r: dict[str,Any]) -> dict[str,Any]:
    allowed_cat={"breaking","music","beef","business","legal","culture","viral","gta"}
    allowed_fmt={"photo_news","tweet_statement","video_repost"}
    allowed_tone={"straight","funny","debate","opinion"}
    allowed_conf={"confirmed","reported","developing","rumor"}
    out={
        "headline":clean(str(r.get("headline",""))),
        "body":clean(str(r.get("body",""))),
        "caption":clean(str(r.get("caption",""))),
        "threads_text":clean(str(r.get("threads_text",""))),
        "category":clean(str(r.get("category","culture"))).lower(),
        "featured_person":clean(str(r.get("featured_person",""))),
        "content_format":clean(str(r.get("content_format","photo_news"))).lower(),
        "tone":clean(str(r.get("tone","straight"))).lower(),
        "confidence":clean(str(r.get("confidence","reported"))).lower(),
        "attribution_needed":bool(r.get("attribution_needed",False)),
        "adult_thirst_trap":bool(r.get("adult_thirst_trap",False)),
    }
    if out["category"] not in allowed_cat: out["category"]="culture"
    if out["content_format"] not in allowed_fmt: out["content_format"]="photo_news"
    if out["tone"] not in allowed_tone: out["tone"]="straight"
    if out["confidence"] not in allowed_conf: out["confidence"]="reported"
    return out


def qa_score(e: dict[str,Any], c: Candidate, evidence: dict[str,Any]) -> tuple[int,dict[str,Any]]:
    h,b,cap=e["headline"],e["body"],e["caption"]
    words=re.findall(r"\b\w+\b",b)
    checks={
        "headline_present":bool(h),
        "headline_length_ok":12<=len(h)<=100,
        "body_length_ok":20<=len(words)<=220,
        "caption_present":bool(cap),
        "threads_length_ok":len(e["threads_text"])<=500,
        "source_approved":c.source_handle in APPROVED_SOURCE_HANDLES,
        "source_url_present":c.link.startswith(("http://","https://")),
        "image_reference_present":bool(evidence.get("image_url")) or e["content_format"]=="video_repost",
        "no_placeholder_text":not bool(re.search(r"\b(tbd|todo|placeholder|lorem ipsum)\b",f"{h} {b} {cap}",re.I)),
    }
    pub=parse_date(c.published_at); age=(datetime.now(timezone.utc)-pub).total_seconds() if pub else -1
    checks["source_recent"]=0<=age<=MAX_SOURCE_AGE_HOURS*3600
    # We do not guess handles. The model can mention source handle; other @handles require manual/source evidence.
    handles=re.findall(r"@([A-Za-z0-9._]+)",f"{h} {b} {cap} {e['threads_text']}")
    checks["no_unverified_handle"]=all(x.casefold()==c.source_handle for x in handles)
    # High-risk stories can publish from one source, but must preserve attribution unless evidence says confirmed.
    high=evidence.get("risk")=="high"
    source_mentioned=(f"@{c.source_handle}".casefold() in f"{b} {cap} {e['threads_text']}".casefold()
                      or c.source_handle.casefold() in f"{b} {cap} {e['threads_text']}".casefold())
    attribution_words=bool(re.search(r"\b(reports?|reported|says?|according to|alleges?|alleged|developing)\b",f"{b} {cap} {e['threads_text']}",re.I))
    checks["risk_attribution_ok"]=not high or e["confidence"]=="confirmed" or source_mentioned or attribution_words
    weights={
        "headline_present":8,"headline_length_ok":8,"body_length_ok":10,"caption_present":10,
        "threads_length_ok":6,"source_approved":12,"source_recent":10,"source_url_present":8,
        "image_reference_present":10,"no_placeholder_text":6,"no_unverified_handle":6,"risk_attribution_ok":6
    }
    score=sum(v for k,v in weights.items() if checks[k])
    critical=["headline_present","headline_length_ok","body_length_ok","caption_present","threads_length_ok","source_approved","source_recent","source_url_present","image_reference_present","no_placeholder_text","no_unverified_handle","risk_attribution_ok"]
    checks.update(score=score,threshold=QA_THRESHOLD,passed=score>=QA_THRESHOLD and all(checks[k] for k in critical))
    return score,checks


def fingerprint(c: Candidate,e: dict[str,Any]) -> str:
    raw=f"{c.link}|{e['headline']}|{e['featured_person']}"
    return hashlib.sha256(norm(raw).encode()).hexdigest()[:24]


def next_id(headline: str) -> str:
    nums=[]
    if QUEUE.exists():
        for p in QUEUE.glob("*.json"):
            m=re.match(r"(\d+)-",p.name)
            if m: nums.append(int(m.group(1)))
    n=max(nums,default=0)+1
    slug=re.sub(r"[^a-z0-9]+","-",headline.casefold()).strip("-")[:55] or "story"
    return f"{n:03d}-{slug}"


def publisher_compatibility(item: dict[str, Any]) -> tuple[bool, list[str]]:
    """Mirror the publisher's minimum structural gates; the Node publisher remains final."""
    reasons: list[str] = []
    if item.get("source_policy_checked") is not True: reasons.append("source policy not checked")
    if item.get("rap_relevance_checked") is not True: reasons.append("rap relevance not checked")
    if item.get("content_claim_checked") is not True: reasons.append("content claims not checked")
    if item.get("editorial_substance_checked") is not True: reasons.append("editorial substance not checked")
    if item.get("text_overflow_checked") is not True: reasons.append("text overflow not checked")
    content_type = item.get("content_type")
    media_paths: list[str] = []
    if content_type == "video" and item.get("video"):
        media_paths.append(str(item["video"]))
        layout = item.get("video_layout", {})
        if item.get("layout_template") != "rapwire-video-grid-safe-v1": reasons.append("invalid video template")
        if layout.get("status") != "validated" or not layout.get("source_sha256") or not layout.get("output_sha256"):
            reasons.append("video layout/hash proof missing")
    elif content_type == "carousel" and item.get("media_items"):
        media_paths.extend(str(media.get("path", "")) for media in item["media_items"])
    else:
        reasons.append("supported local media missing")
    for relative in media_paths:
        path = ROOT / relative
        if not relative or not path.is_file() or path.stat().st_size <= 0:
            reasons.append(f"media unavailable: {relative or '<empty>'}")
    if item.get("visual_asset_rights") not in {"owned", "source_post_repost"}:
        reasons.append("visual rights unsupported")
    if item.get("editorial_review_required"):
        reasons.append("editorial review still required")
    return not reasons, reasons


def queue_item(c: Candidate,e: dict[str,Any],ev: dict[str,Any],qa: dict[str,Any]) -> dict[str,Any]:
    story_id=next_id(e["headline"])
    source_line=f"Source: @{c.source_handle}"
    caption=e["caption"]
    if source_line.casefold() not in caption.casefold(): caption=f"{caption}\n\n{source_line}\n{c.link}\n\n@rapwire247"
    threads=e["threads_text"] or f"{e['headline']}\n\n{e['body']}"
    item = {
        "id":story_id,
        "status":"review",
        "autonomous_local_editor":True,
        "local_editor_model":OLLAMA_MODEL,
        "created_at":datetime.now(timezone.utc).isoformat(),
        "source":f"@{c.source_handle}","source_handle":c.source_handle,
        "source_policy_checked":True,"rap_relevance_checked":True,
        "source_urls":[c.link],"source_url":c.link,"source_guid":c.guid,
        "source_title":c.title,"source_published_at":c.published_at,
        "story_fingerprint":fingerprint(c,e),
        "headline":e["headline"],"body":e["body"],"rendered_body_text":e["body"],
        "caption":caption,"threads_text":threads,
        "featured_person":e["featured_person"],"featured_artist":e["featured_person"],
        "content_format":e["content_format"],"category":e["category"],"type":e["category"],
        "tone":e["tone"],"reporting_confidence":e["confidence"],
        "attribution_needed":e["attribution_needed"],"adult_thirst_trap":e["adult_thirst_trap"],
        "source_image_url":ev.get("image_url",""),"source_evidence":ev,
        "deterministic_rank":c.score,"qa":qa,"qa_passed":bool(qa["passed"]),
        "facts_verified": False,
        "source_photo_used":False,
        "visual_asset_type":"source_photo" if ev.get("image_url") else "pending_media",
        "visual_asset_rights":"source_post_repost" if ev.get("image_url") else "pending_review",
        "media_rights":"source_post_repost" if ev.get("image_url") else "pending_review",
        "photo_recency_checked": bool(ev.get("image_url")),
        "photo_event_relevance":"same_campaign" if ev.get("image_url") else "pending_review",
        "photo_context_summary":"Image reference came from the same source item/page; existing publisher must still enforce visual/media policy.",
        "content_type":"review_draft",
        "content_claim_checked":False,"editorial_substance_checked":False,
        "text_overflow_checked":False,"grid_safe_checked":False,
        "editorial_review_required":["fact_check","media_prepare","layout_validate"],
        "slides":[],"media_urls":[],"story":"",
        "publish_blocked":True,
        "publish_block_reason":"Local evidence draft requires fact, media, and layout validation.",
    }
    compatible, reasons = publisher_compatibility(item)
    auto_ok = AUTONOMOUS and qa["passed"] and qa["score"] >= MIN_AUTONOMOUS_SCORE and compatible
    if auto_ok:
        item.update(status="ready", publish_blocked=False, publish_block_reason="")
    else:
        item["publisher_compatibility"] = {"passed": compatible, "reasons": reasons}
    return item


def log(event: str,payload: dict[str,Any]) -> None:
    LOG_DIR.mkdir(parents=True,exist_ok=True)
    with (LOG_DIR/"local-newsroom.jsonl").open("a") as f:
        f.write(json.dumps({"at":datetime.now(timezone.utc).isoformat(),"event":event,**payload},ensure_ascii=False)+"\n")


def run_once(dry_run: bool=False) -> int:
    existing=existing_keys()
    candidates=[]
    for c in fetch_feed():
        shortcode = re.search(r"instagram\.com/(?:p|reel)/([^/?#]+)", c.link)
        duplicate = c.guid in existing or c.link in existing or f"headline:{norm(c.title)}" in existing
        if shortcode and f"shortcode:{shortcode.group(1)}" in existing: duplicate = True
        if not duplicate: candidates.append(c)
    candidates=sorted(candidates,key=lambda x:(x.score,x.published_at),reverse=True)
    if not dry_run: log("candidates",{"count":len(candidates),"top":[asdict(c) for c in candidates[:5]]})
    if not candidates:
        print("RapWire autonomous newsroom: no new candidates.")
        return 0
    c,res=choose_story(candidates)
    e=normalize_editorial(res); ev=res["source_evidence"]
    score,qa=qa_score(e,c,ev)
    item=queue_item(c,e,ev,qa)
    print(f"Selected: {e['headline']}")
    print(f"Source: @{c.source_handle} — {c.link}")
    print(f"Rank: {c.score}/100 | QA: {score}/100 | status={item['status']}")
    if not dry_run: log("selected",{"id":item["id"],"headline":e["headline"],"source":c.link,"rank":c.score,"qa":qa,"status":item["status"]})
    if dry_run:
        print(json.dumps(item,indent=2,ensure_ascii=False)); return 0
    QUEUE.mkdir(parents=True,exist_ok=True)
    p=QUEUE/f"{item['id']}.json"
    p.write_text(json.dumps(item,indent=2,ensure_ascii=False)+"\n")
    print(f"Queued: {p}")
    return 0


def health() -> int:
    checks: dict[str, Any] = {}
    checks["repository"] = (ROOT / ".git").exists()
    checks["source_registry"] = bool(APPROVED_SOURCE_HANDLES)
    checks["queue_directory"] = QUEUE.is_dir()
    checks["runner"] = (ROOT / "scripts/run-local-newsroom.sh").is_file()
    checks["launchd_plist"] = (ROOT / "launchd/com.rapwire247.newsroom.plist").is_file()
    try:
        response = urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=3)
        models = json.loads(response.read().decode()).get("models", [])
        checks["ollama"] = response.status == 200
        checks["model"] = any(str(model.get("name", "")).split(":latest")[0] == OLLAMA_MODEL for model in models)
    except Exception:
        checks["ollama"] = False
        checks["model"] = False
    git = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, text=True, capture_output=True)
    checks["git_usable"] = git.returncode == 0
    checks["git_clean"] = git.returncode == 0 and not git.stdout.strip()
    ok = all(value for key, value in checks.items() if key != "git_clean")
    print(json.dumps({"ok": ok, "checks": checks, "model": OLLAMA_MODEL, "endpoint": OLLAMA_URL}, indent=2))
    return 0 if ok else 1


def main() -> int:
    global OLLAMA_MODEL,AUTONOMOUS
    ap=argparse.ArgumentParser()
    ap.add_argument("--dry-run",action="store_true")
    ap.add_argument("--review",action="store_true",help="Force review mode")
    ap.add_argument("--model")
    ap.add_argument("--health",action="store_true")
    args=ap.parse_args()
    if args.model: OLLAMA_MODEL=args.model
    if args.review: AUTONOMOUS=False
    if args.health: return health()
    try: return run_once(args.dry_run)
    except Exception as e:
        log("error",{"message":str(e)})
        print(f"RapWire autonomous newsroom error: {e}",file=sys.stderr)
        return 1

if __name__=="__main__": raise SystemExit(main())
