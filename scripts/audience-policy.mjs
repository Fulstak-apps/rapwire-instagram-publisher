// Editorial classification is a selection hint, never evidence of a news claim.
const legal = /\b(?:trial|court|judge|fbi|arrest\w*|charg(?:e|ed|es)|plea|plead\w*|testif\w*|testimony|witness\w*|prosecutor\w*|lawsuit|murder|sentenc\w*|verdict|bail)\b/i;
const sensitive = /\b(?:died|death|killed|victim\w*|funeral|hospital\w*|suicide|abuse|assault\w*)\b/i;
const music = /\b(?:album|single|song|mixtape|music|release|tour|concert|rapper|rap|verse|bars|freestyle|lyric\w*|catalog\w*|top\s*(?:5|five|10|ten)|goat|greatest)\b/i;
const artists = [
  [/\b(?:jay[- ]?z|shawn carter)\b/i, 'Jay-Z'], [/\b(?:drake|champagnepapi)\b/i, 'Drake'],
  [/\b(?:kendrick(?: lamar)?|k\. ?dot)\b/i, 'Kendrick'], [/\b(?:nicki minaj)\b/i, 'Nicki'],
  [/\b(?:lil wayne|weezy)\b/i, 'Lil Wayne'], [/\b(?:j\.? cole)\b/i, 'J. Cole'],
  [/\b(?:lil durk|durkio)\b/i, 'Lil Durk'], [/\b(?:nas)\b/i, 'Nas'],
];
function pick(options, seed) {
  let hash = 0;
  for (const char of String(seed)) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return options[hash % options.length];
}
export function editorialTopic(text) {
  if (legal.test(text)) return 'court';
  if (sensitive.test(text)) return 'sensitive';
  if (/\b(?:gta\s*6|grand theft auto|playstation|xbox|nintendo|gaming|video game|street fighter)\b/i.test(text)) return 'gaming';
  if (music.test(text)) return 'music';
  return 'culture';
}

// Threads accepts one topic tag per post.  Prefer a named subject when the
// caption has an independently verified artist/company identity; otherwise use
// a clear, platform-recognized editorial topic.  This is metadata for Threads,
// not extra copy, so it never changes the reported claim.
export function threadsTopicTag(text, {artistMentions = []} = {}) {
  const verified = (artistMentions || []).find(person => person?.name && person?.handle);
  if (verified) return verified.name;
  const topic = editorialTopic(text);
  if (topic === 'court') return 'Hip-Hop News';
  if (topic === 'gaming') return /\b(?:gta\s*6|grand theft auto)\b/i.test(String(text || '')) ? 'Grand Theft Auto VI' : 'Gaming';
  if (topic === 'music') return 'Hip-Hop';
  return 'Hip-Hop Culture';
}
export function editorialSeries(text, {storyType = ''} = {}) {
  const value=String(text||'');
  if (editorialTopic(value)==='court') return 'Case File';
  if (/\b(?:released|release date|out now|drops?|new album|new single|new track)\b/i.test(value)) return 'New Music Watch';
  if (storyType==='throwback' || /\b(?:classic|from the vault|throwback|archive)\b/i.test(value)) return 'From the Vault';
  if (/\b(?:top\s*(?:5|five|10|ten)|goat|greatest|rank\w*|overrated|underrated)\b/i.test(value)) return 'RapWire Debate';
  if (discussionPrompt(value,'series-check')) return 'RapWire Debate';
  return 'What Happened?';
}
export function discussionPrompt(text, seed = text) {
  const value = String(text || '');
  if (value.trim().length < 15) return '';
  if (value.includes('?')) return ''; // Preserve a source's relevant question; do not stack prompts.
  const topic = editorialTopic(value);
  // A person's name never overrides the context of a case or a tragedy.
  if (topic === 'sensitive') return '';
  if (topic === 'court') return pick([
    'Before y’all pick a side, what detail needs more context?',
    'What would you need to see in the record before changing your mind?',
    'What matters more here: the testimony or the evidence behind it?',
  ], seed);
  if (topic === 'gaming') return pick([
    'Y’all playing this day one, or waiting on reviews?', 'What would make this worth the money?',
    'Be real: gameplay or story—which one matters more here?',
  ], seed);
  if (topic === 'music') {
    const matches = artists.filter(([pattern]) => pattern.test(value)).map(([, name]) => name);
    if (matches.length === 1) {
      const name = matches[0];
      if (/\b(?:freestyle|verse|bars)\b/i.test(value)) return pick([`Be real: where does this land in ${name}'s best verses?`, `Y’all got this in ${name}'s best-verse conversation, or nah?`],seed);
      if (/\b(?:tour|concert|performance|performed|stage)\b/i.test(value)) return pick([`Y’all think ${name} is better live or on record?`, `Be real: is ${name} actually elite live?`],seed);
      if (/\b(?:new album|new single|new song|new track|released)\b/i.test(value)) return pick([`Where does this fit in ${name}'s catalog for y’all?`, 'Y’all hearing replay value, or just rollout hype?'],seed);
      return pick([
        `Y’all really got ${name} top 5? Who comes off your list?`,
        `${name}: all-time great or overrated? Be real.`,
        `Where do y’all rank ${name}, and which project makes the case?`,
      ], seed);
    }
    return pick(['What project are y’all putting up against this?', 'Y’all hearing replay value, or rollout hype?', 'What is really carrying your ranking here?'], seed);
  }
  if (/\b(?:beef|diss|argument|clash|debate)\b/i.test(value)) return 'Whose argument holds up better to y’all—and why?';
  // Rap/culture posts still need a real entry point, but never a generic
  // engagement demand. The question asks for a comparison or point of view.
  if (/\b(?:hip.?hop|rap|rapper|artist|producer|dj|mixtape|freestyle|bars|culture)\b/i.test(value)) return pick([
    'What artist or moment does this make y’all think of first?',
    'Is this really adding to the conversation, or just going viral?',
    'What context would change how y’all see this?',
  ], seed);
  return '';
}

// A short conversational closing line makes the feed read like a real hip-hop
// desk without changing any reported source facts. Sensitive and court posts
// deliberately receive no engagement hook.
export function captionVoicePrompt(text, seed = text) {
  const value=String(text||'');
  if(value.includes('?') || ['court','sensitive'].includes(editorialTopic(value))) return '';
  if(editorialTopic(value)==='gaming') return pick(['Y’all playing this day one, or waiting it out?', 'Day one, or y’all need to see more first?'],seed);
  if(editorialTopic(value)==='music') return pick(['Y’all running this back, or nah?', 'This staying in rotation for y’all, or nah?', 'Be real—y’all feeling this one?'],seed);
  if(/\b(?:hip.?hop|rap|rapper|artist|producer|dj|mixtape|freestyle|bars|culture)\b/i.test(value)) return pick(['Y’all buying this, or nah?', 'What y’all think about this one?', 'This got a real point, or nah?'],seed);
  return '';
}

export function fitDiscussionText(text, max = 450) {
  const value = String(text || '').trim();
  if ([...value].length <= max) return value;
  const sentences = value.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  let fitted = '';
  for (const sentence of sentences) {
    if ([...(fitted + sentence).trim()].length > max) break;
    fitted += sentence;
  }
  // Never publish a fragment merely to fit a discussion question.
  return fitted.trim();
}
export function composeThreads(text, { seed = text, source = '', artistMentions = [] } = {}) {
  const handle = String(source).replace(/^@/, '').toLowerCase();
  const cleaned = String(text || '').replace(/^Source commentary:\s*/i, '')
    .split('\n').filter(line => !['@rapwire247', `@${handle}`].includes(line.trim().toLowerCase())).join('\n').trim();
  if (!cleaned) return '@rapwire247';
  const question = discussionPrompt(cleaned, seed);
  const footer = '\n\n@rapwire247';
  const budget = 500 - [...footer].length - (question ? [...question].length + 2 : 0);
  let body = fitDiscussionText(cleaned, budget);
  let prompt = question;
  if (!body && cleaned) { body = fitDiscussionText(cleaned, 500 - [...footer].length); prompt = ''; }
  if (!body) return ''; // Caller holds an unfit Threads caption, not the Instagram post.
  return [body, prompt, '@rapwire247'].filter(Boolean).join('\n\n');
}

export function selectReply(rootText, comment, seed = comment) {
  const text = String(comment || '').trim();
  if (text.length < 16 || text.length > 800 || /https?:\/\/|\b(?:dm me|follow me|giveaway)\b/i.test(text)) return null;
  if (/\b(?:kill yourself|idiot|moron|stupid|retard\w*|nigg\w*|fagg\w*)\b/i.test(text)) return null;
  const topic = editorialTopic(rootText);
  if (topic === 'sensitive' || sensitive.test(text)) return null;
  if (topic === 'court') {
    if (/\b(?:source|evidence|record|transcript|testimony)\b/i.test(text)) return { mode: 'clarify', text: 'Which part of the record are you referring to? That context matters before calling it proof.' };
    return null;
  }
  const ranking = /\b(?:top\s*(?:5|five|10|ten)|goat|best|greatest|rank\w*|overrated|underrated)\b/i;
  if (topic === 'music' && (ranking.test(rootText) || ranking.test(text))) {
    // A ranking prompt does not make every unrelated reply a music debate.
    if (!ranking.test(text) && !/\b(?:catalog\w*|albums?|projects?|pen|lyrics?|writing|flows?|bars|music|influence|longevity|consistency|sales|streams|numbers|charts|agree|disagree|exactly|facts|right|wrong)\b/i.test(text)
      && !artists.some(([pattern])=>pattern.test(text))) return null;
    if (/\b(?:catalog\w*|albums?|longevity|consistency)\b/i.test(text) && !/\b(?:not|no|never|disagree|wrong|overrated)\b/i.test(text)) {
      return {mode:'agree', text:pick(['I agree that the full catalog belongs in the argument. Which album makes your case?', 'Consistency is a fair criterion. Which three projects are carrying your ranking?'], seed)};
    }
    if (/\b(?:sales|streams|numbers|charts)\b/i.test(text)) return {mode:'challenge', text:'Numbers show reach. Should they decide a top-five ranking ahead of writing and catalog?'};
    if (/\b(?:disagree|wrong|overrated|not|never)\b/i.test(text)) return {mode:'challenge', text:'Who takes that spot on your list, and which project makes the difference?'};
    if (/\b(?:agree|exactly|facts|right)\b/i.test(text)) return {mode:'agree', text:'I can see that argument. Which project is the one you would put up against anybody?'};
    return {mode:'clarify', text:'What decides your list: pen, catalog, or influence? Pick the one that carries the most weight.'};
  }
  if (topic === 'gaming' && /\b(?:gameplay|story|price|reviews)\b/i.test(text)) return {mode:'clarify', text:'What would you need to see in the gameplay or reviews to change your mind?'};
  return null;
}
