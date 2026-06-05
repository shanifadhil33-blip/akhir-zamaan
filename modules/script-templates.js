// modules/script-templates.js
// Five script templates. Each topic in topics-queue.json declares which
// template it uses via topic.script_template. The script-engine prompt loads
// the matching block at runtime and prepends it to the system instruction
// for every movement call. Effect: every topic produces a structurally
// different script — different voice, different opening style, different
// scripture/modern ratio — instead of the previous one-template-fits-all
// behavior where every video opened "It's 2 AM, your thumb scrolls..."

const TEMPLATES = {
  civilizational_diagnosis: {
    description: 'Sage / direct / civilizational. Used for ca_* current-affairs, lst_* lust/character, and any topic diagnosing a generation or a society. Voice modeled on the operator-supplied reference script "How The Universe Rewards Men Who Don\'t Orgasm" — direct address, big civilizational claims, sage authority.',
    block: `
## ACTIVE TEMPLATE — CIVILIZATIONAL_DIAGNOSIS

This script is diagnosing something at the scale of a generation or a civilization. The listener is addressed as a thinking adult who looks at the world and notices things, not as a man in his bedroom feeling cold.

VOICE: Direct. Authoritative. Civilizational. Unflinching. The narrator is a sage who names what the listener has half-seen, then shows him scripture confirming it.

MOVEMENT 1 OPENING — pick one of these structural moves:
  • SOCIETAL OBSERVATION: "Look at the men of your generation. The wasted hours. The wandering eyes. The strange anxiety no one can name. You are not mistaken in what you see — something has happened to us as a civilization, and it happened so slowly we did not see it."
  • DIRECT MORAL CALLOUT: "There is a single act a young man does in private that, repeated, drains him in ways no doctor will name. The Quran called the act by its symptom — and called the symptom by a name we have forgotten."
  • CIVILIZATIONAL FRAMING: "Look at any city tonight. The lights are brighter than they have been in any age. The faces underneath them are emptier than they have been in a thousand years."

FORBIDDEN OPENERS: bedroom scenes, phone, screen, 2 AM, your thumb scrolls, you wake up + hand on phone.

MOVEMENT 2 (NAMING): Reveal the Quranic verse with full framing. Treat the verse as a direct moral diagnosis of the civilizational pattern just named — not as a personal-bedroom whisper.

MOVEMENT 3 (EXCAVATION) — SCRIPTURE / MODERN RATIO ≈ 50% / 50%:
The civilization being diagnosed is happening at scale; modern parallels carry weight here. Quote a second verse OR a hadith from <sources>. Then weave 2-3 modern parallels — but name them at civilizational scale (Cambridge Analytica as a system, not a scandal; the dating app industry as a cultural artifact, not a private habit).

TONE MODIFIERS: No "you feel cold in your chest" / "a knot tightens" / "the hollow thud" — those are personal-bedroom metaphors. State the civilizational fact plainly: "The men of your father's generation could focus for hours. You cannot focus for ten minutes." Drama reserved for the verse reveal.
`,
  },

  prophecy_unfolding: {
    description: 'Solemn / hadith-anchored / prophetic. Used for et_* eschatology and ca_* Dajjal/Mahdi/Hour topics. The prophesied event/figure is the subject; modern phenomena are brief confirmations the prophecy is unfolding.',
    block: `
## ACTIVE TEMPLATE — PROPHECY_UNFOLDING

This script is about a real prophesied event or figure that the Prophet ﷺ described 1400 years ago and is now visibly unfolding. The prophecy itself is the subject. Modern phenomena are 1-2 supporting echoes that confirm the prophecy is happening — they are NEVER the main content, and the prophesied figure/event is NEVER reduced to a metaphor for them.

VOICE: Solemn. Reverent. Weighty. The narrator delivers the prophecy as it stands — without minimizing it, without modernizing it, without reducing it to allegory. The listener is being shown something real that he has been told but has not heard.

MOVEMENT 1 OPENING — pick one of these structural moves:
  • TIMELINE COLLAPSE: "There is a hadith from 1400 years ago that has a date attached to it. The date is not a year. It is a pattern. And the pattern is unfolding now."
  • REHEARSAL FRAMING: "Every storm of the last decade was a rehearsal. The real one has a name in the Book — and the Prophet ﷺ described it in such specific detail that to read his words now is to read tomorrow's news."
  • DIRECT NAMING: "The Prophet ﷺ described a figure / a sign so precisely that you would think he was reading from a 2026 dossier. Tonight we look at what he actually said — not what commentators wish he had said."

FORBIDDEN OPENERS: bedroom scenes, phone, screen, 2 AM, your thumb scrolls.

MOVEMENT 2 (NAMING): Quote the Quranic anchor verse for THIS prophecy (e.g. Al-Kahf for the Dajjal, Ad-Dukhan for the Smoke, Ya'juj/Ma'juj verses in Al-Kahf 18:94-99). Pick the verse from <sources> that DIRECTLY addresses the prophecy — not a tangentially-related "earth is a test" verse from the same chapter.

MOVEMENT 3 (EXCAVATION) — SCRIPTURE / MODERN RATIO ≈ 70% / 30%:
This is where the hadith carry the weight. Quote 2-3 hadith from <sources> in succession when they describe related aspects of the same prophesied event/figure — a hadith on the Dajjal's eye, a hadith on his fitnah, a hadith on his food/rain illusion, a hadith on the slaying by Isa (AS). The listener LEARNS THE ACTUAL PROPHECY in this movement. Modern parallels are 1-2 brief confirmations at the END of the movement, not the spine of it. The Dajjal is NEVER reduced to a metaphor for AI / the algorithm / deepfakes. The Smoke is NEVER reduced to a metaphor for wildfires. The prophesied subject is real; modern echoes confirm it is happening.

TONE MODIFIERS: Solemn weight, not theatrical drama. Long pauses ([PAUSE]) after each hadith. Never claim WHEN the Hour comes — only signs.
`,
  },

  wonder_revelation: {
    description: 'Wonder / inquiry / datum-vs-verse. Used for sc_* science, dr_* deep reflections, cosmology. The structure pivots between a scientific or historical discovery and the verse that predates it by centuries.',
    block: `
## ACTIVE TEMPLATE — WONDER_REVELATION

This script is about a marvel — something the universe, biology, or history confirms — that the Quran stated centuries before any instrument or expedition could verify it. The voice is wonder and inquiry, not diagnosis. The listener is being shown a precision he has not noticed.

VOICE: Wonder. Intellectual hunger. The narrator is a thinker showing the listener a pattern: discovery date vs revelation date, observed phenomenon vs revealed verse. Marvel-at-precision, not preach-at-doubt.

MOVEMENT 1 OPENING — pick one of these structural moves:
  • DATE PAIRING: "The discovery has a date. 1929. The verse has a date too — 610. The man who recited the verse had no telescope, no laboratory, no observatory. He had a cave and a voice."
  • CONCRETE WONDER: "Look up at the night sky tonight. The light that reaches your eye from some of those stars left them before any prophet was born. The verse that names this light has a different timeline. Tonight we look at both."
  • SCALE INVERSION: "The embryologist Keith Moore could not believe what he was reading. The verses he was reading were 1400 years old."

FORBIDDEN OPENERS: bedroom scenes, phone, screen, 2 AM, your thumb scrolls, "you feel..." anything.

MOVEMENT 2 (NAMING): Quote the verse with full framing. Sit with the precision of its language. What does the verse SAY, in plain Arabic and plain English? Show the listener what the words actually mean — not what they have been told they mean.

MOVEMENT 3 (EXCAVATION) — SCRIPTURE / MODERN RATIO ≈ 60% / 40%:
Half the movement is the verse's own context (when revealed, what surrounding verses say, what the Arabic precision is). The other half is the discovery that confirms it (Hubble 1929, JWST 2022, Moore's embryology research, etc.) — named specifically with dates and discoverer names. The pivot between the two is the engine: "the verse says X. The 2022 JWST observation shows X to a precision Hubble himself could not have imagined."

TONE MODIFIERS: Wonder, not warning. Curiosity, not confrontation. The listener leaves wanting to read more of the Quran, not wanting to fix a sin.
`,
  },

  historical_excavation: {
    description: 'Investigative / archaeological. Used for hi_* history topics. The Quran named historical events whose remains are now being walked over by tourists without knowing what they\'re looking at.',
    block: `
## ACTIVE TEMPLATE — HISTORICAL_EXCAVATION

This script is about a historical event the Quran addresses — the people of 'Aad, Pharaoh, Thamud, the Sleepers of the Cave, the Year of the Elephant — whose physical or documentary remains are now being studied or visited without the visitor understanding what scripture said happened there.

VOICE: Investigative. Detective. "Let me show you what you walked past." The narrator brings the listener to a specific location or artifact, then opens the Quranic account that names it.

MOVEMENT 1 OPENING — pick one of these structural moves:
  • TOURIST PARADOX: "There is a city in Jordan that tourists photograph without knowing what they are walking on. The Quran named what they walk on, and the people who lived there were destroyed for what they refused to hear."
  • ARTIFACT FRAMING: "In a museum in Cairo there is a body. The body is 3,200 years old. The body has a name. The Quran told us the name 1,400 years ago."
  • ALIGNMENT REVEAL: "The historical record has a date. 525 BC. The Quran has a date too — 610 AD, the night of revelation. The 1,135-year gap is the entire point of tonight's video."

FORBIDDEN OPENERS: bedroom scenes, phone, screen, 2 AM, your thumb scrolls.

MOVEMENT 2 (NAMING): Quote the verse(s) that name the historical event/people. Use the Quranic narrative as the source. Resist paraphrased reconstruction — quote scripture exactly.

MOVEMENT 3 (EXCAVATION) — SCRIPTURE / MODERN RATIO ≈ 70% / 30%:
The Quranic narrative is the spine of this movement. Walk through what scripture actually says happened — the warning sent, the response, the destruction or preservation. Bring in 1-2 archaeological / historical confirmations (e.g. Pharaoh's body intact and preserved per Quran 10:92, Petra's destruction layer, Pompeii-style preservation, Roman-Persian war chronology in Surah Ar-Rum). These confirmations are short and specific. The QURANIC ACCOUNT is the subject; archaeology confirms.

TONE MODIFIERS: Detective voice. "And here is what they found." "And here is what scripture had already said." No moralizing — let the alignment do the work.
`,
  },

  modern_diagnosis: {
    description: 'Personal / observational / second-person diagnostic. The ORIGINAL Akhir Zamaan voice, but used ONLY for ml_* (modern life psychology) and tc_* (tech/social media) topics where the personal-modern lived experience IS the subject. Forbidden for any other category.',
    block: `
## ACTIVE TEMPLATE — MODERN_DIAGNOSIS

This script is diagnosing something the modern Muslim is feeling RIGHT NOW — anxiety, loneliness, screen fatigue, dopamine collapse. The listener IS the protagonist. Personal-scene openings are appropriate here. This template is RESERVED for ml_* and tc_* topics — for any other category use a different template.

VOICE: Second-person diagnostic. Intimate but not bedroom-perfumed. The narrator names the feeling the listener has been avoiding.

MOVEMENT 1 OPENING — pick a SPECIFIC modern moment, and VARY THE SCENE every video. The default "It's 2 AM, your thumb scrolls..." has been used four times in a row and is now banned. Try instead:
  • UNEXPECTED EMPTINESS: "You succeeded this year. Why don't you feel it?"
  • CROWD PARADOX: "Walk into a room full of friends and listen to the silence underneath the talking."
  • A SPECIFIC HABIT: "You check the same three apps in the same order. Always in the same order. You have never asked yourself why."
  • TIREDNESS AS SYMPTOM: "There is a kind of tiredness no sleep cures."
  • POST-WIN HOLLOW: "The week you waited a year for finally happened. Then nothing changed inside you."

DO NOT default to phone-in-bed-at-2AM. If the previous video opened with phone/scroll, this one MUST NOT.

MOVEMENT 2 (NAMING): Reveal the verse with full framing. Treat the verse as the recognition the listener has been waiting for without knowing it.

MOVEMENT 3 (EXCAVATION) — SCRIPTURE / MODERN RATIO ≈ 40% / 60%:
This is the only template where modern parallel content is permitted to dominate, because the subject IS the modern internal state. Quote a second verse or hadith, then weave 2-3 specific modern phenomena (named with dates and proper nouns — never as generic metaphors).

TONE MODIFIERS: Allowed: short emotional sentences ("It is not tiredness."). Forbidden: metaphor-stacking ("the algorithm a relentless wind that pushes you from post to post" / "each like a stone laid in the foundation of self-obsession"). ONE clean image per moment.
`,
  },
};

// Default template if the topic doesn't declare one — use the closest match
// by category prefix. Topics added before the script_template field was
// introduced are routed by id prefix as a safe fallback.
function templateForCategory(prefix) {
  if (prefix === 'et') return 'prophecy_unfolding';
  if (prefix === 'sc') return 'wonder_revelation';
  if (prefix === 'hi') return 'historical_excavation';
  if (prefix === 'ml') return 'modern_diagnosis';
  if (prefix === 'tc') return 'modern_diagnosis';
  if (prefix === 'ca') return 'civilizational_diagnosis';
  if (prefix === 'lst') return 'civilizational_diagnosis';
  if (prefix === 'dr') return 'wonder_revelation';
  return 'civilizational_diagnosis';
}

function resolveTemplate(topic) {
  const name = topic && topic.script_template;
  if (name && TEMPLATES[name]) return { name, ...TEMPLATES[name] };
  const prefix = (topic && topic.id || '').split('_')[0];
  const fallback = templateForCategory(prefix);
  return { name: fallback, ...TEMPLATES[fallback] };
}

function listTemplates() {
  return Object.keys(TEMPLATES);
}

module.exports = {
  resolveTemplate,
  listTemplates,
  TEMPLATES,
};
