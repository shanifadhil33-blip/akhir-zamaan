// modules/content-policy.js
// Single source of truth for what kinds of modern grounding the channel
// allows. Used by research.js (Tavily query generation + result synthesis)
// and modern-context.js (LLM-only synthesis fallback). Also passed as a
// system-prompt addendum so any LLM call producing modern parallels sees
// the same banlist + approved-patterns list.
//
// Background: after the first ~12 videos, the operator caught the
// search-grounding module pulling individual Western celebrities
// (Kanye West's antisemitic tweets, Megan Thee Stallion v. Tory Lanez,
// Harvey Weinstein, #MeToo, TikTok personalities) into deeply sacred
// Islamic eschatology scripts. This is tonal poison for the channel.
// The fix is to lock the modern-grounding scope to SYSTEMIC trends
// (algorithmic patterns, surveillance infrastructure, attention-economy
// effects) and forbid the named-individual layer entirely.

// Categories of forbidden grounding content — both for search queries
// AND for synthesized "events" the LLM might pull from training memory.
const FORBIDDEN_PATTERNS = [
  // Named individuals — celebrities, influencers, politicians, athletes
  'individual celebrity names (musicians, actors, athletes, social-media influencers, podcasters, streamers)',
  'named Western political figures (presidents, prime ministers, congresspeople — except in strict geopolitical-systemic context like sanctions or wars, never as personal scandals)',
  'CEO and founder names treated as individuals (Elon Musk personal life, Zuckerberg personal life — but their COMPANIES as systemic actors are fine)',
  'celebrity court cases, divorces, scandals, cancellation campaigns',
  'pop-culture moments (award shows, viral tweets from named individuals, celebrity beefs)',
  'sports moments (championship results, athlete controversies, fan reactions)',
  'royalty / monarchy news',
  'social-media accusations against named persons of any kind',
];

// Categories of APPROVED grounding content — what the LLM should look for instead.
const APPROVED_PATTERNS = [
  'systemic technological shifts (rollout of AI models, biometric ID networks, deepfake capability becoming consumer-grade, surveillance infrastructure at scale)',
  'algorithmic behavior patterns (echo chambers, recommendation systems, attention capture, addiction loops) — described at the system level, not as one celebrity\'s controversy',
  'public health / cognitive findings (attention-span studies, loneliness epidemiology, sleep degradation, dopamine research)',
  'geopolitical macro-events (wars, treaties, mass displacement, economic collapse, currency events) — at the policy / nation-state level, never as personal drama',
  'economic / monetary system changes (CBDCs, inflation cycles, debt expansion, riba structures becoming visible)',
  'scientific discoveries (cosmology confirmations, archaeological finds, embryology, climate observations)',
  'demographic / cultural shifts (marriage rates, birth rates, religious affiliation trends, mass migration patterns)',
  'natural phenomena (volcanic activity, solar events, atmospheric phenomena, mass animal deaths)',
];

// Specific names that have leaked into prior scripts and must be hard-banned.
// Substring match — case-insensitive. If any of these appear in a search
// query OR in a synthesized event description, the entry is rejected.
const HARD_BANLIST = [
  'kanye west', 'ye ',
  'megan thee stallion', 'tory lanez',
  'harvey weinstein', '#metoo',
  'zelensky',                  // appears in synthetic-media context but as a person; rephrase to "deepfake of a head of state"
  'donald trump', 'biden', 'kamala harris',
  'kardashian', 'jenner',
  'mr beast', 'mrbeast',
  'andrew tate', 'tate',
  'jordan peterson', 'peterson',
  'elon musk personal', 'musk\'s tweets',
  'taylor swift', 'rihanna', 'beyonce',
  'drake', 'kendrick',
  'cristiano ronaldo', 'lionel messi',
  'amber heard', 'johnny depp',
  'will smith oscar', 'will smith slap',
  'queen elizabeth', 'king charles', 'prince harry', 'meghan markle',
  // Channel-specific: prior scripts hallucinated these references
  'cambridge analytica',       // permitted at SYSTEMIC level only — "data-driven consent engineering" — never as a 2018 scandal headline
];

// The prompt block injected as a system-instruction addendum to every
// modern-grounding LLM call (search-query generator, synthesizer,
// modern-context fallback). Tells the LLM what scope of grounding is
// acceptable and shows the exact failure mode it must avoid.
const POLICY_PROMPT_BLOCK = `
## CHANNEL CONTENT POLICY — MODERN GROUNDING SCOPE (NON-NEGOTIABLE)

This channel — Akhir Zamaan — produces deeply sacred Islamic eschatology
and spiritual reflection scripts. Modern grounding (events, statistics,
patterns from 2023-2026) is welcome ONLY when it stays at the SYSTEMIC
level. Individual celebrity / pop-culture / political-personality
references are forbidden — they break the tonal gravity the audience
expects and have caused script rejections.

### FORBIDDEN content categories (reject if you produce any of these):
${FORBIDDEN_PATTERNS.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

### APPROVED content categories (this is what you may search for and synthesize):
${APPROVED_PATTERNS.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

### HARD-BANNED specific names (zero tolerance, do not produce in any form):
${HARD_BANLIST.slice(0, 24).map((n) => `  • ${n}`).join('\n')}
  • (and any analogous celebrity / political-personality reference)

### TRANSLATION GUIDE — how to keep the systemic insight without the celebrity:
  • Instead of "Kanye West's antisemitic tweets in 2022" → "platform-scale public shaming campaigns triggered by single posts"
  • Instead of "Megan Thee Stallion v. Tory Lanez" → "social-media courts that issue verdicts before any legal verdict"
  • Instead of "Harvey Weinstein / #MeToo" → "mass-exposure cycles where accusation alone destroys reputation"
  • Instead of "the Zelensky deepfake of 2022" → "head-of-state deepfakes circulated as authentic"
  • Instead of "Trump's 2024 conviction" → "Western political leaders facing simultaneous legal and electoral pressure"
  • Instead of "Elon Musk's tweets" → "platform owners shaping discourse by personal decree"

### IF THE TOPIC IS PURELY SPIRITUAL / HISTORICAL / JURISPRUDENTIAL:
The topic does not need modern grounding at all. Return an empty or
near-empty events array. Do not force modern analogies onto a script
where they do not naturally fit. The script-engine can run on Quranic
content alone for spiritually-anchored topics — that is correct, not
a gap. The "AAKHIR ZAMAAN" audience prefers depth over forced
relevance.

### THE HAYA (MODESTY) MANDATE:
When the modern grounding touches sins of the age (vanity, indecency,
public shaming, intoxicants, immodest entertainment), name them at the
level of the SOUL — never illustrate the filth. Zero explicit references
to nightlife scenes, specific immodest attire, explicit relationships,
or lewd behaviors. The events you synthesize must describe the systemic
spiritual disease, never the outward sensory detail of the haram.

### CONCEPTUAL ABSTRACTION — required pattern for all synthesized events:
Rewrite every modern reference as an archetypal / philosophical
observation, not as a news headline. Study these before/after pairs:

  ❌ "Kanye West canceled on Twitter for antisemitic posts (2022)"
  ✅ "Mass-scale digital shaming campaigns where a single utterance
      destroys reputation in hours — the public square has become a
      stoning ground for words"

  ❌ "TikTok's 2024 algorithm update increased average session time"
  ✅ "Silent code that consumes the hours of a generation, feeding
      endless distraction until the remembrance of God fades"

  ❌ "Megan Thee Stallion v. Tory Lanez tried on Twitter before court"
  ✅ "Verdicts now arrive through the algorithm before the gavel
      falls — the crowd condemns a man whose full ledger only the
      Knower of the Unseen has read"

### THE TIMELESSNESS TEST (FINAL VALIDATION):
Before submitting any event or pattern, ask: "Would this entry still
make perfect sense and carry the same weight if read 50 years from now?"
If the entry sounds like cable news from today, REJECT and rewrite
abstractly. If it sounds like a timeless observation of systemic
human / civilizational trial, APPROVE.

  • "Twitter's 2024 mass-suspension wave" → FAILS (platform may not exist)
  • "Platform-scale algorithmic shaming as the new town square" → PASSES
  • "Andrew Tate's 2023 arrest in Romania" → FAILS (individual + date)
  • "False prophets of masculinity selling counterfeit strength to
     fatherless men" → PASSES

The whole point of the channel is that the Quran spoke to these
patterns 1400 years ago. The grounding entries must read like they
could have been written 50 years from now, looking back at our age
with the same clarity the Quran looked forward to it.
`.trim();

// Predicate used by research.js result-filtering — drops any search
// result whose URL or content contains a hard-banned name.
function containsBannedName(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return HARD_BANLIST.some((name) => lower.includes(name));
}

// Used to filter synthesized event lists post-hoc — drops any entry whose
// `event` description still leaks a banned name, in case the LLM ignored
// the policy block in its prompt.
function filterSynthesizedEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const text = `${e.event || ''} ${e.thematic_link || ''}`;
    return !containsBannedName(text);
  });
}

function filterSynthesizedPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns.filter((p) => {
    if (!p || typeof p !== 'object') return false;
    const text = `${p.pattern || ''} ${p.manifestation || ''} ${p.why_it_matters || ''}`;
    return !containsBannedName(text);
  });
}

module.exports = {
  POLICY_PROMPT_BLOCK,
  HARD_BANLIST,
  FORBIDDEN_PATTERNS,
  APPROVED_PATTERNS,
  containsBannedName,
  filterSynthesizedEvents,
  filterSynthesizedPatterns,
};
