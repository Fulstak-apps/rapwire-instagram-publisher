// Editorial priority, supplied by the publisher. These names affect ordering
// only; they never turn a weak, stale, duplicated, or unverified claim into a
// publishable story.
export const PRIORITY_ARTISTS=[
  ['Playboi Carti',['playboi carti','carti']],['Travis Scott',['travis scott']],['Kendrick Lamar',['kendrick lamar','kendrick','k dot']],['Drake',['drake']],['Skrilla',['skrilla']],['EsDeeKid',['esdeekid','es dee kid']],['Ken Carson',['ken carson']],['Yeat',['yeat']],['BossMan Dlow',['bossman dlow','boss man dlow']],['OsamaSon',['osamason','osama son']],['Nettspend',['nettspend']],['Lazer Dim 700',['lazer dim 700','lazerdim700']],['Xaviersobased',['xaviersobased']],['Tyler, The Creator',['tyler the creator','tyler, the creator']],['21 Savage',['21 savage']],['Future',['future']],['Destroy Lonely',['destroy lonely']],['BigXthaPlug',['bigxthaplug','bigx the plug']],['Loe Shimmy',['loe shimmy']],['Gunna',['gunna']],['Lil Uzi Vert',['lil uzi vert','lil uzi']],['Baby Keem',['baby keem']],['Don Toliver',['don toliver']],['Central Cee',['central cee']],['Young Thug',['young thug']],['Hunxho',['hunxho']],['BabyChiefDoIt',['babychiefdoit','baby chief doit']],['YTB Fatt',['ytb fatt']],['1900Rugrat',['1900rugrat','1900 rugrat']],['Rich Amiri',['rich amiri']],['Hurricane Wisdom',['hurricane wisdom']],['Fakemink',['fakemink']],['SahBabii',['sahbabii']],['Zeddy Will',['zeddy will']],['Cash Cobain',['cash cobain']],['Skaiwater',['skaiwater']],['Jim Legxacy',['jim legxacy']],['Slayr',['slayr']],['Babyfxce E',['babyfxce e','babyfxcee']],['Nino Paid',['nino paid']],['Veeze',['veeze']],['Key Glock',['key glock']],['Young Nudy',['young nudy']],['Rob49',['rob49','rob 49']],['Tee Grizzley',['tee grizzley']],['GloRilla',['glorilla','glo rilla']],['Sexyy Red',['sexyy red']],['Doechii',['doechii']],['Latto',['latto']],['Megan Thee Stallion',['megan thee stallion','megan the stallion']]
];

const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const aliasMatch=(value,alias)=>new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${escape(alias)}(?=$|[^\\p{L}\\p{N}_-])`,'iu').test(value);
export function priorityArtistsIn(text='') {
  const value=String(text||'');
  return PRIORITY_ARTISTS.filter(([,aliases])=>aliases.some(alias=>aliasMatch(value,alias))).map(([name])=>name);
}
export const hasPriorityArtist=text=>priorityArtistsIn(text).length>0;
