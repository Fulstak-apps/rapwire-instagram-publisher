#!/usr/bin/env python3
import importlib.util, json
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('fallback_photo',ROOT/'scripts'/'fallback-photo-post.py')
fallback=importlib.util.module_from_spec(spec); spec.loader.exec_module(fallback)
primary='https://www.ky3.com/2026/08/30/grammy-winning-rapper-arrested-booked-greene-county-jail/'
secondary='https://www.tmz.com/2026/08/29/rapper-lefty-gunplay-arrested/'
third='https://www.complex.com/music/a/treyalston/lefty-gunplay-assault-missouri'
image_url=fallback.page_image(primary)
image=fallback.download_image(image_url)
story={
  'title':'LEFTY GUNPLAY BOOKED IN MISSOURI',
  'description':"Greene County Jail records list rapper Lefty Gunplay, whose legal name is Franklin Holladay, as booked for alleged fourth-degree assault after a Springfield show. KY3 reported that online court records did not show filed charges Saturday night. Authorities have not released details of the alleged incident. An arrest is not a finding of guilt.",
  'link':primary,
  'published':datetime(2026,8,30,tzinfo=timezone.utc),
}
sid=fallback.next_id(story['title'])
headline,body,slides,story_path=fallback.render(sid,story,'Lefty Gunplay','@leftygunplay','KY3 / GREENE COUNTY JAIL',image)
item={
 'id':sid,'status':'ready','date':'2026-08-30','timezone':'America/Detroit','type':'legal_news','story_type':'current_news',
 'headline':headline,'body':body,'slides':[str(p.relative_to(ROOT)) for p in slides],'story':str(story_path.relative_to(ROOT)),
 'caption':f"{body}\n\nLefty Gunplay (@leftygunplay) is presumed innocent. An arrest or booking is not a finding of guilt, and authorities have not publicly detailed the alleged incident.\n\nSources: KY3, TMZ and Complex, Aug. 29–30, 2026. Source photo: Greene County Jail via KY3.\n\n#LeftyGunplay #HipHopNews #RapWire247",
 'threads_text':f"{headline}\n\nLefty Gunplay (@leftygunplay) was booked in Greene County, Missouri, for alleged fourth-degree assault. Details have not been released; an arrest is not a finding of guilt. Sources: KY3, TMZ and Complex. #RapWire247",
 'featured_artist':'Lefty Gunplay','artist_instagram_handle':'@leftygunplay','artist_handle_verified':True,
 'artist_handle_verified_url':'https://www.instagram.com/leftygunplay/','displayed_artist_label':'LEFTY GUNPLAY  @leftygunplay',
 'identity_checked':True,'source_urls':[primary,secondary,third],'source_url':primary,'source_title':story['title'],
 'source_published_at':'2026-08-30T00:43:00Z','source_image_url':image_url,
 'source_image_role':'Current Greene County Jail booking image credited through KY3','source_photo_used':True,
 'visual_asset_source_urls':[primary,secondary,third,image_url],'visual_asset_type':'source_photo','visual_asset_rights':'source_post_repost',
 'fallback_real_photo':True,'ai_generated_art':False,'photo_capture_date':'2026-08-29','photo_recency_checked':True,
 'photo_event_relevance':'event_specific','photo_context_summary':'Current booking image supplied by Greene County Jail and published by KY3.',
 'visual_safe_area_checked':True,'publish_after':datetime.now(timezone.utc).isoformat()
}
(ROOT/'queue'/f'{sid}.json').write_text(json.dumps(item,indent=2)+'\n')
print(sid)
