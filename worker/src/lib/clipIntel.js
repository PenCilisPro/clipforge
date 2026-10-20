import { createHash } from "node:crypto";
import { chatComplete } from "./zai.js";

/**
 * Clip Intelligence v2.1 — transcript-based clip selector with dead-air cutting.
 *
 * v2.1 adds the viewer-retention model ("why a viewer stops scrolling"):
 * open question + reason to care in the hook window (caps + penalty),
 * repetition ratio, wind-down enforcement after the payoff, ending-action
 * prediction and a computed gut check. Text-only proxies — logged in
 * intel_json.retention, tuned like every other number.
 *
 * The model picks sentence IDs, classifies archetypes and scores dimensions
 * against anchors. THIS module owns everything that can be computed:
 * ID -> time mapping, trims, dead-air edit plan, duration, verbatim checks,
 * headline fact checks, payoff position, filler/dead-air detection, score caps,
 * penalties, totals, threshold, dedupe and ranking. The model never sets the total.
 *
 * Every number tagged [mine] is a starting default — retune it from the
 * performance data logged in intel_json.
 */

// ---------- configuration ([mine] unless noted) ----------
export const CONFIG = {
  HOOK_WINDOW: 5,                 // seconds — [A] "first 5 seconds"
  PAYOFF_MIN_POSITION: 0.6,       // payoff starts at >= 60% of clip — [mine], from [A]
  GAP_COMPRESS: 0.8,              // silences above this are cut down to KEEP_GAP
  GAP_HARD: 2.0,                  // any internal gap above this (after editing) = dead_air
  FILLER_MAX: 8,                  // filler words per 100 words (after editing) before dead_air
  THRESHOLD: 6.5,                 // minimum total to ship
  CANDIDATE_MULTIPLIER: 2,        // MAX_CANDIDATES = 2 x target_count
  OVERLAP_LIMIT: 0.2,             // dedupe when overlap > 20% of the shorter clip
  WINDOW: 720,                    // 12-minute analysis windows
  WINDOW_OVERLAP: 120,            // 2-minute overlap
  PATTERN_BONUS: 0.5,             // per matched engagement pattern
  PATTERN_BONUS_CAP: 1.0,
  DURATION_SLACK: 1.0,            // tolerance on MIN/MAX since cuts land on sentence edges
  ARCHETYPE_CAP: { max: 2, topN: 5, margin: 1.0 }, // set to null to disable
  AUTO_TRIM_LEADING_FILLER: true, // trim leading filler even if the model forgot to
  MAX_LEADING_TRIM: 4,
  MAX_TRAILING_TRIM: 6,
  SEG_SILENCE: 0.6,               // split unpunctuated transcripts at silences >= this
  SEG_MAX_WORDS_UNPUNCTUATED: 25,
  SEG_MAX_WORDS_PUNCTUATED: 60,   // safety cap for run-on sentences
  CHUNK_CONCURRENCY: 3,
  TRANSCRIPT_CHAR_CAP: 120_000,
  MODEL_TIMEOUT_MS: 240_000,
  MODEL_TEMPERATURE: 0.2,

  // ---- dead-air cutting [mine] ----
  CUT_DEAD_AIR: true,
  KEEP_GAP: 0.25,            // a cut silence is shortened to about this many seconds
  PAD_BEFORE: 0.08,          // kept before a word so its onset isn't clipped
  PAD_AFTER: 0.12,           // kept after a word so its tail isn't clipped
  MIN_CUT: 0.3,              // never make a cut that removes less than this
  MIN_SEGMENT: 0.25,         // shorter kept pieces are merged (avoids stutter cuts)
  CUT_FILLER_WORDS: true,    // remove um / uh / er / erm mid-clip
  CUT_FILLER_PHRASES: false, // "you know", "I mean", "kind of", "sort of" (can carry meaning, so off)

  // ---- viewer-retention model — "why a viewer stops scrolling" [mine] ----
  WIND_DOWN_MAX_SEC: 4,       // at most this many seconds after the payoff — "they swipe during the wind-down"
  WIND_DOWN_MAX_SENTS: 1,     // at most one reaction sentence after the payoff sentence
  REPETITION_MAX_RATIO: 0.12, // repeated 4-gram share (after editing) before "it repeats, rambles"
  REPETITION_MIN_WORDS: 16,   // need at least this many kept words before the ratio means anything
  HOOK_CARE_CAP: 6,           // hook_strength cap when the hook window has no reason to care
  HOOK_DEAD_CAP: 4,           // hook_strength cap when it has neither an open question nor a reason to care
};

const WEIGHTS = { hook_strength: 0.30, peak: 0.30, second: 0.10, retention_flow: 0.20, audience_fit: 0.10 };
const PENALTY_VALUES = {
  payoff_too_early: 2,
  dead_air: 1,
  needs_outside_context: 2,
  hook_content_mismatch: 3,
  off_audience: 1.5,
  no_clean_ending: 3,
  // viewer-retention penalties
  wind_down_tail: 1,       // the clip keeps going after the payoff — viewers swipe during the wind-down
  repeats_itself: 1,       // mid-clip repetition ("it repeats, rambles")
  no_reason_to_care: 1.5,  // hook has neither an open question nor any reason to care — "who cares?"
};

const LENGTH_BOUNDS = {
  "10-14": { min: 10, max: 14 },
  "15-30": { min: 15, max: 30 },
  "31-45": { min: 31, max: 45 },
  "60+": { min: 60, max: 90 },
  ai_optimized: { min: 20, max: 60 }, // spec defaults
};

const SCORE_KEYS = ["hook_strength", "unexpected_turn", "emotion_relatability", "information_value", "retention_flow", "audience_fit"];
const TRAIT_KEYS = ["unexpected_turn", "emotion_relatability", "information_value"];
const ARCHETYPES = new Set(["twist", "polarizing_take", "emotional_peak", "tip_or_myth_bust", "promise_journey_payoff", "standoff_resolution"]);
const FORMULAS = new Set(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"]);

// ---------- text detection ----------
const TERMINAL_RE = /[.!?]["'”’)\]]*$/;
const ABBREV_RE = /^(mr|mrs|ms|dr|st|vs|etc|jr|sr|prof|e\.g|i\.e|u\.s)\.$/i;
const LEAD_FILLER_ONE = new Set(["um", "umm", "uh", "uhh", "er", "erm", "so", "okay", "ok", "alright", "well", "now", "yeah", "anyway", "right"]);
const LEAD_FILLER_TWO = new Set(["you know", "i mean", "all right"]);
const DENSITY_ONE = new Set(["um", "umm", "uh", "uhh", "er", "erm"]);
const DENSITY_TWO = new Set(["you know", "i mean", "kind of", "sort of"]);
const CUT_FILLER_ONE = new Set(["um", "umm", "uh", "uhh", "er", "erm", "hmm"]);
const GREETING_RE = /^(hi|hey|hello|yo|welcome|whats up|good (morning|afternoon|evening))\b/;
const HOUSEKEEPING_RE = /\b(like and subscribe|hit (the )?subscribe|link in the description|before we go on|word from (our|today's) sponsor|this (video|episode) is sponsored|welcome back|thanks for watching|see you (next time|in the next))\b/i;
const PRONOUN_I_RE = /^i(m|ve|ll|d)?$/i;
const STOPWORDS = new Set(("the a an and or but if then than so to of in on at by for with from up out about into over after before " +
  "is are was were be been being am do does did have has had will would can could should may might must " +
  "i you he she it we they me him her us them my your his its our their this that these those there here " +
  "what why how when where who which not no just very really all any some more most other such only own same too " +
  "said says say get got one").split(" "));

// ---------- system prompt ----------
const SYSTEM_PROMPT_TEMPLATE = `You are the clip-selection engine for a short-form video product. You receive a transcript of long-form video, pre-split into numbered sentences. You return the clips most likely to hold viewer attention on YouTube Shorts, TikTok and Reels, each with a hook. You never see the video, only text and timing. Output JSON only, matching the schema at the end.

INPUT
Each transcript line looks like:  S014 [312.40-315.10] gap=0.20 SPEAKER_1: text
- S014 is the sentence ID. [a-b] are start and end seconds. gap is the silence in seconds before the sentence. The speaker label may be missing.
- A clip is a contiguous run of sentences. You choose it by start_id and end_id. Never output raw timestamps.
- The request block gives: mode (select or score_only), target_count, and optionally creator_profile, engagement_patterns and window.
- In score_only mode you are given fixed start_id and end_id values. Do not search for other clips. Fill in the same fields and scores for that range and return exactly one clip.

PARAMETERS
HOOK_WINDOW = {{HOOK_WINDOW}} seconds (about 12 spoken words). MIN_DURATION = {{MIN_DURATION}} s. MAX_DURATION = {{MAX_DURATION}} s. The payoff must start at or after {{PAYOFF_MIN_POSITION}} of the clip length. MAX_CANDIDATES = {{MAX_CANDIDATES}}.
Inside a clip, silences longer than {{GAP_COMPRESS}} s and hesitation sounds (um, uh, er) are cut automatically by the editor. Count clip length as speaking time, and do not lower retention_flow for pauses that will be cut.

1. HOW THE VIEWER DECIDES
- The clip appears to someone mid-scroll. Nobody chose it, and swiping costs nothing, so swiping is what happens by default. The clip has to earn every next second.
- The viewer decides in the first HOOK_WINDOW seconds. People keep watching only while they still need to know something. As soon as they don't, they swipe. So the payoff must come last. Never choose a start point that places the answer, punchline, twist or reveal inside the hook window.
- Three things must be there. Remove any one and the clip dies:
  * An open question: What happens next? What's the answer? Did he really just say that?
  * A reason to care: something at stake (money, embarrassment, a relationship), a person they recognize, "that's literally me", a strong feeling, or something useful to them.
  * Nothing in the way: no slow start, no confusion about who's talking, no pauses, no repeating.
- Question but no stakes = "who cares?". Stakes but no question = "I already know how this ends". Both, but slowed down = they leave before the good part.
- The viewer asks four questions, in order. 0-1 s "What is this?": they stay if someone is mid-sentence or mid-reaction with energy and the on-screen text is short and specific; they swipe on a black frame, a logo, someone settling in, "hey guys". 1-5 s "Do I care?": they stay if they can see the topic and what's at stake but not how it ends; they swipe if it is vague or gives the answer away. 5 s to end "Where's this going?": they stay if each line gets closer to the answer, raises the stakes or surprises them; they swipe if it repeats, rambles, pauses, or the answer already came. End "Was that worth it?": they stay if the ending delivers exactly what the start promised; they swipe if the ending is flat or the start promised something else.
- The hook covers the first two questions, the structure covers the third, and the payoff covers the last. Confused viewers do not stop to figure things out — they just swipe.
- The headline gives away the first surprise, not the ending. Naming the first turn makes the question bigger instead of answering it.
- The hook makes a promise. The rest of the clip must deliver exactly that promise.
- End as soon as the last question is answered. The wind-down after the payoff is where viewers swipe away: no "that's wild", no next-topic transition, no thank-you, no host chat.
- Endings drive actions: rewatch (the ending was quick, or changed what the start meant), share (strong feeling, or "this is so you"), save (useful), comment (something to disagree with), follow (they want more of this person). Set ending_outcome to the strongest one the clip genuinely earns.
- If you have to choose, choose the event over the hook. A great hook on a dull moment only moves the swipe from second 2 to second 8, and now the viewer feels tricked.
- The best hook is usually a line already in the video, so the real decision is where the clip starts. The headline adds what that line cannot show: who's talking, what's at stake.
- Shares and saves are strong signals. High-arousal emotion drives shares. Useful, specific information drives saves.
- Simple clips win. A strong moment with plain editing beats a weak moment with a heavy edit. Dead air, greetings and throat-clearing lose viewers.

2. CLIP ARCHETYPES
Classify every clip as exactly one of these.

twist
 What: a setup, then a reversal the viewer does not predict (pattern interrupt, plot twist, shocking line).
 Signals: reversal connectors right after a setup ("but", "then he said", "turns out", "until", "instead", "except", "that's when"); a direct quote that flips what the previous sentences set up; praise followed by an insult, or the reverse; "I didn't expect".
 Cut: start at the earliest sentence needed to understand the setup. End on the final reversal, plus at most one reaction sentence of 4 seconds or less.
 Preferred headline formulas: F1, F6, F8.

polarizing_take
 What: a claim that makes different viewers react in opposite ways.
 Signals: absolutes ("always", "never", "nobody", "everyone", "the only"); "unpopular opinion"; opinions on divisive topics; a person or brand that provokes strong reactions; us-versus-them framing.
 Cut: start on the claim sentence. End after the strongest supporting line or the interviewer's reaction. Do not end on a balanced "two sides" line if it kills the tension.
 Preferred headline formulas: F3, F6.

emotional_peak
 What: the viewer instantly laughs, feels angry, feels inspired, or thinks "this is exactly me".
 Signals: first-person vulnerability; stakes (money, family, fear, embarrassment); laughter or exclamation; "I can't believe", "I was so"; a relatable situation in one or two sentences.
 Cut: start 1-2 sentences before the peak so it builds. End right after the peak line. No wind-down.
 Preferred headline formulas: F5, F6.

tip_or_myth_bust
 What: a quick tip, a hack, or a corrected misconception the viewer wants to save.
 Signals: "here's how", "the trick is", "most people think", "actually", "did you know", "stop doing", "the reason is"; numbers, steps, quantities; imperative verbs; concrete nouns.
 Cut: start at the problem or the myth. Never start at the fix. End at the fix, plus a one-sentence recap only if it fits within MAX_DURATION.
 Preferred headline formulas: F2, F3, F7.

promise_journey_payoff
 What: hook states a goal, bet or challenge; progression shows the attempt and an obstacle; climax fulfills the promise.
 Signals: a goal early ("I want to be the first to...", "we have 24 hours", "I'm going to..."); an obstacle ("but there's a problem"); steps; fulfillment ("and that's when it worked").
 Cut: start at the promise. Keep one obstacle. End at the fulfillment.
 Preferred headline formulas: F4, F5.

standoff_resolution
 What: a two-person exchange where a claim or accusation creates tension at the start and the last lines resolve it.
 Signals: speaker alternation; a bold self-description or accusation; quoted lines; unresolved tension that the final sentences settle.
 Cut: start at the claim or entrance. End at the resolution line.
 Preferred headline formulas: F1, F8.

3. PROCEDURE
Step 1. Group consecutive sentences into beats. Mark a beat boundary where the topic changes or gap is 1.5 s or more.
Step 2. Mark signal sentences using the archetype signals above.
Step 3. For each signal cluster, find the payoff sentence: where the question is answered, the twist lands, the fix is stated, or the goal is fulfilled.
Step 4. Walk back from the payoff to find the start. Take the latest sentence from which the first two sentences are understandable without outside context. Do not go earlier than the beat start. Keep setup under 40% of the clip so the payoff lands at 60% or later.
Step 5. Walk forward from the payoff to find the end. End on the payoff sentence, or one reaction sentence of 4 seconds or less after it. Never include the next topic, a thank-you, a sign-off, a host transition, or a sponsor read.
Step 6. Check the hook window. If the answer, twist, punchline or fix is inside the first HOOK_WINDOW seconds, try moving the start up to 20 seconds earlier to add setup. If no earlier start fixes it, reject with payoff_too_early. Do not reorder sentences.
Step 7. Check duration. If shorter than MIN_DURATION, extend the start backward by whole sentences inside the same beat. If still too short, reject with below_min_duration. If longer than MAX_DURATION, tighten the start or reject with above_max_duration.
Step 8. Leading filler. If the first spoken word is a filler or discourse marker (um, uh, er, so, okay, alright, well, now, yeah, anyway, right, "you know", "I mean"), add a trim_ops entry that drops those words. Count only filler at the very start.
Step 9. Fill in hook_checks, context, scores and penalty_flags using the anchors in section 5. Report filler_or_greeting_open honestly for the untrimmed start.
Step 10. Return at most MAX_CANDIDATES clips that would reach the quality bar. Put the rest in rejected with a reason. Returning fewer clips, or none, is correct when the footage has few strong moments. Never pad.

4. HOOKS AND HEADLINES
- spoken_text is the full text of the sentence or sentences that overlap the first HOOK_WINDOW seconds, copied exactly from the transcript. If the opening sentence is not a hook, pick a different start. If none works, reject. Never write a spoken hook that is not in the transcript.
- The headline is at most 12 words, sentence case, no all caps.
- The headline may use only facts, names and numbers that appear in the transcript window you were given.
- The headline must tease, not resolve. It must not contain the payoff. It may state the setup or the first turn.
- The headline must be something the clip delivers. Otherwise it is a hook_content_mismatch.
- Formulas:
 F1 Tease the turn: "[setup fact]. [first turn]." Stop before the payoff.
 F2 Question the viewer has: "Why does [common thing] always [bad outcome]?"
 F3 Counter-claim: "[Group] is wrong about [topic]." Only if the clip says it.
 F4 Quest: "[Person] tried to [goal] in [constraint]."
 F5 Stakes: "[Thing at risk] on [uncertain outcome]."
 F6 Quote lead: a verbatim shocking line from the clip that is not the payoff line.
 F7 Stop instruction: "Stop [doing X] when you [activity]."
 F8 Named curiosity gap: "What [Name] said when [situation]."
- Not allowed: generic bait with no content ("You won't believe this"), headlines that reveal the answer, headlines that name something not in the transcript.

5. SCORING ANCHORS (0-10 integers)
hook_strength (first HOOK_WINDOW seconds only):
 0-2 greeting, filler, throat-clearing, or no context. 3-5 on topic but flat; answers instead of asking, or vague. 6-8 a clear claim or tension plus one open question, concrete detail. 9-10 immediate tension, two or more open questions, no payoff, and a concrete name, number or detail in the first 12 words. A hook with no open question, or with no reason to care (no stakes, no recognizable person, no strong feeling, nothing useful), is a 4 or less.
unexpected_turn:
 0-2 none. 3-5 mild shift in tone or topic. 6-8 clear reversal of what the previous sentences set up. 9-10 a reversal that flips the meaning of the setup, lands within two sentences, and could not be guessed.
emotion_relatability:
 0-2 neutral. 3-5 mildly amusing or engaging. 6-8 strong feeling shown by explicit emotional language or real stakes. 9-10 high-arousal and shareable, polarizing or deeply relatable.
information_value:
 0-2 none. 3-5 general knowledge. 6-8 one specific, new, usable tip or corrected misconception. 9-10 specific, counter-intuitive, immediately actionable, summarizable in one sentence.
retention_flow:
 0-2 long pauses, heavy filler, rambling. 3-5 some rambling, needs two or more trims. 6-8 continuous, at most one trim. 9-10 continuous, every sentence adds information or tension, payoff in the last 25%, end could loop to the start.
audience_fit:
 If no creator_profile is given, score 5. 0-2 clashes with the profile's audience. 8-10 directly matches the profile's audience and topics that work.
A clip needs only one strong attention trait. unexpected_turn, emotion_relatability and information_value are alternatives, not requirements. Score all three honestly; do not inflate a trait the clip does not have.

PENALTY FLAGS (report honestly; code applies the values)
- no_clean_ending: the clip ends mid-thought or without delivering the payoff.
- hook_content_mismatch: the headline or hook promises something the clip does not deliver.
- off_audience: the topic clashes with creator_profile.

HARD REJECTS (go in rejected, not clips)
- payoff_too_early, no_payoff, below_min_duration, above_max_duration
- housekeeping: intros, outros, "welcome back", "before we go on", "like and subscribe", "link in the description", sponsor reads, breaks, stage logistics
- needs_outside_context: the first two sentences contain a reference no allowed start can resolve
- visual_dependent: the only interest is something the transcript cannot show
- policy_risk_hold: harassment of a private individual, hateful content, dangerous misinformation, or sexual content. Do not drop silently.

6. RULES
- Use only sentence IDs that exist in the input. Never invent text. Every quote must be verbatim.
- Do not use facts from outside the transcript.
- Every clip gets a one-sentence reason naming the archetype and the strongest trait.
- Set hook.reason_to_care to the strongest reason a viewer cares (or none) and ending_outcome to the strongest action the ending earns. Code verifies the care claim against the hook-window text.
- If engagement_patterns are provided, list only the IDs the clip genuinely matches in matched_patterns.
- Output valid JSON only. No commentary, no markdown.

OUTPUT SCHEMA
{
  "clips": [{
    "start_id": "S101", "end_id": "S106",
    "archetype": "twist | polarizing_take | emotional_peak | tip_or_myth_bust | promise_journey_payoff | standoff_resolution",
    "hook": { "spoken_text": "verbatim", "headline": "max 12 words, no payoff", "formula": "F1-F8", "reason_to_care": "stakes | recognition | strong_feeling | useful | none", "open_questions": ["...", "..."] },
    "ending_outcome": "rewatch | share | save | comment | follow",
    "payoff_id": "S105",
    "hook_checks": { "introduces_topic": true, "raises_open_question": true, "payoff_in_window": false, "filler_or_greeting_open": false, "concrete_detail": true },
    "context": { "dangling_reference": null, "resolved_by": "clip | headline | none" },
    "trim_ops": [ { "op": "drop_leading_words | drop_trailing_words", "count": 1, "why": "..." } ],
    "estimates": { "filler_per_100_words": 0, "max_internal_gap_sec": 0.0 },
    "scores": { "hook_strength": 0, "unexpected_turn": 0, "emotion_relatability": 0, "information_value": 0, "retention_flow": 0, "audience_fit": 0 },
    "penalty_flags": { "no_clean_ending": false, "hook_content_mismatch": false, "off_audience": false },
    "matched_patterns": [],
    "reason": "one sentence naming the archetype and strongest trait",
    "risks": [],
    "hashtags": ["3-5 lowercase topical tags, no spaces, no #"]
  }],
  "rejected": [ { "start_id": "S320", "end_id": "S322", "reasons": ["payoff_too_early"], "note": "short explanation" } ],
  "skipped_reason": null
}
Order clips best first. Do not output a total score.`;

// =====================================================================
// Segmentation
// =====================================================================

function formatSpeaker(s) {
  if (s == null || String(s).trim() === "") return null;
  const str = String(s).trim();
  return /^\d+$/.test(str) ? `SPEAKER_${str}` : str.replace(/\s+/g, "_").toUpperCase();
}

/**
 * Split word timestamps into sentences. Punctuated transcripts split on
 * terminal punctuation; unpunctuated ones split at silence >= 0.6 s or 25 words.
 * Speaker changes always split. Exported so the golden set can reproduce IDs.
 */
export function segmentSentences(rawWords) {
  const words = (Array.isArray(rawWords) ? rawWords : [])
    .map((w) => ({
      word: String(w?.word ?? w?.text ?? "").trim(),
      start: Number(w?.start),
      end: Number(w?.end),
      speaker: w?.speaker ?? w?.speaker_id ?? null,
    }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
  if (words.length === 0) return { sentences: [], words, punctuated: false };

  const punctuated = words.filter((w) => TERMINAL_RE.test(w.word)).length / words.length >= 0.02;
  const maxWords = punctuated ? CONFIG.SEG_MAX_WORDS_PUNCTUATED : CONFIG.SEG_MAX_WORDS_UNPUNCTUATED;

  const groups = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (cur.length > 0 && prev) {
      const speakerChange = w.speaker != null && prev.speaker != null && w.speaker !== prev.speaker;
      const silence = !punctuated && w.start - prev.end >= CONFIG.SEG_SILENCE;
      if (speakerChange || silence) { groups.push(cur); cur = []; }
    }
    cur.push(i);
    const terminal = punctuated && TERMINAL_RE.test(w.word) && !ABBREV_RE.test(w.word);
    if (terminal || cur.length >= maxWords) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);

  const pad = Math.max(3, String(groups.length).length);
  const sentences = groups.map((g, idx) => {
    const first = words[g[0]];
    const last = words[g[g.length - 1]];
    const prevEnd = idx > 0 ? words[groups[idx - 1][groups[idx - 1].length - 1]].end : 0;
    return {
      idx,
      num: idx + 1,
      id: `S${String(idx + 1).padStart(pad, "0")}`,
      start: first.start,
      end: last.end,
      gap: Math.max(0, first.start - prevEnd),
      speaker: formatSpeaker(first.speaker),
      text: g.map((i) => words[i].word).join(" "),
      wStart: g[0],
      wEnd: g[g.length - 1],
    };
  });
  return { sentences, words, punctuated };
}

function formatLine(s) {
  return `${s.id} [${s.start.toFixed(2)}-${s.end.toFixed(2)}] gap=${s.gap.toFixed(2)}${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`;
}

function transcriptBlock(sentences) {
  const lines = [];
  let length = 0;
  for (const s of sentences) {
    const line = formatLine(s);
    if (length + line.length + 1 > CONFIG.TRANSCRIPT_CHAR_CAP) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/** 12-minute windows with 2-minute overlap, on sentence boundaries. IDs stay global. */
function chunkSentences(sentences, duration) {
  const { WINDOW, WINDOW_OVERLAP } = CONFIG;
  if (duration <= WINDOW + WINDOW_OVERLAP) return [{ sentences, from: 0, to: duration }];
  const chunks = [];
  let from = 0;
  while (from < duration) {
    const to = Math.min(from + WINDOW, duration);
    const inWindow = sentences.filter((s) => s.start >= from && s.start < to);
    if (inWindow.length) chunks.push({ sentences: inWindow, from, to });
    if (to >= duration) break;
    from = to - WINDOW_OVERLAP;
  }
  return chunks;
}

// =====================================================================
// Prompt + parsing
// =====================================================================

function fillPrompt({ min, max, maxCandidates }) {
  return SYSTEM_PROMPT_TEMPLATE
    .replaceAll("{{HOOK_WINDOW}}", String(CONFIG.HOOK_WINDOW))
    .replaceAll("{{MIN_DURATION}}", String(min))
    .replaceAll("{{MAX_DURATION}}", String(max))
    .replaceAll("{{PAYOFF_MIN_POSITION}}", String(CONFIG.PAYOFF_MIN_POSITION))
    .replaceAll("{{MAX_CANDIDATES}}", String(maxCandidates))
    .replaceAll("{{GAP_COMPRESS}}", String(CONFIG.GAP_COMPRESS));
}

function buildRequest({ mode, targetCount, creatorProfile, patterns, sentences, window, clip }) {
  const req = { mode, target_count: targetCount };
  if (creatorProfile) req.creator_profile = creatorProfile;
  if (patterns.length) req.engagement_patterns = patterns;
  if (window) req.window = window;
  if (clip) req.clip = clip;
  req.transcript = transcriptBlock(sentences);
  return JSON.stringify(req, null, 2);
}

function parseResponse(content) {
  const cleaned = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  let parsed;
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    parsed = JSON.parse(cleaned.slice(objStart, cleaned.lastIndexOf("}") + 1));
  } else if (arrStart !== -1) {
    parsed = { clips: JSON.parse(cleaned.slice(arrStart, cleaned.lastIndexOf("]") + 1)) };
  } else {
    throw new Error("response contained no JSON");
  }
  return {
    clips: Array.isArray(parsed?.clips) ? parsed.clips : [],
    rejected: Array.isArray(parsed?.rejected) ? parsed.rejected : [],
    skipped_reason: parsed?.skipped_reason ? String(parsed.skipped_reason) : null,
  };
}

// =====================================================================
// Text helpers
// =====================================================================

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampNum(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

function parseId(x) {
  const m = String(x ?? "").trim().match(/^S?0*(\d+)$/i);
  return m ? Number(m[1]) : NaN;
}

function leadingFillerCount(words) {
  let i = 0;
  while (i < words.length) {
    const a = normalize(words[i].word);
    const ab = i + 1 < words.length ? `${a} ${normalize(words[i + 1].word)}` : "";
    if (LEAD_FILLER_TWO.has(ab)) { i += 2; continue; }
    if (LEAD_FILLER_ONE.has(a)) { i += 1; continue; }
    break;
  }
  return i;
}

function fillerPer100(words) {
  const n = words.map((w) => normalize(w.word)).filter(Boolean);
  let count = 0;
  for (let i = 0; i < n.length; i++) {
    if (DENSITY_ONE.has(n[i])) count++;
    else if (i + 1 < n.length && DENSITY_TWO.has(`${n[i]} ${n[i + 1]}`)) { count++; i++; }
  }
  return n.length ? (count * 100) / n.length : 0;
}

function maxInternalGap(words) {
  let maxGap = 0;
  for (let i = 1; i < words.length; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g > maxGap) maxGap = g;
  }
  return maxGap;
}

function contentWords(text) {
  const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  return [...new Set(normalize(text).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem))];
}

/** V7 — share of headline content words that also appear in the payoff sentence(s). */
function payoffLeakRatio(headline, payoffText) {
  const h = contentWords(headline);
  if (h.length < 2) return 0;
  const p = new Set(contentWords(payoffText));
  return h.filter((w) => p.has(w)).length / h.length;
}

/** V6 — every capitalized name and every number in the headline must exist in the window. */
function headlineFactProblems(headline, ctx) {
  const tokens = headline.split(/\s+/).filter(Boolean);
  const problems = [];
  tokens.forEach((tok, i) => {
    const core = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/i, "");
    if (!core) return;
    if (/\d/.test(core)) {
      const num = core.replace(/[^\d.]/g, "").replace(/\.$/, "");
      if (num && !new RegExp(`(^|[^\\d])${num.replace(/\./g, "\\.")}(?!\\d)`).test(ctx.windowDigits)) problems.push(core);
      return;
    }
    const startsSentence = i === 0 || /[.!?:]["'”’]?$/.test(tokens[i - 1]) || /^["'“‘]/.test(tok);
    if (startsSentence || PRONOUN_I_RE.test(normalize(core)) || !/^\p{Lu}/u.test(core)) return;
    const parts = normalize(core).split(" ");
    if (!parts.every((p) => ctx.windowWords.has(p))) problems.push(core);
  });
  return problems;
}

function sanitizeTrimOps(ops) {
  let lead = 0;
  let trail = 0;
  const kept = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    const count = Math.floor(Number(op?.count));
    if (!(count > 0)) continue;
    if (op.op === "drop_leading_words") lead += count;
    else if (op.op === "drop_trailing_words") trail += count;
    else continue;
    kept.push({ op: op.op, count, why: String(op.why ?? "").slice(0, 120) });
  }
  return { lead, trail, ops: kept };
}

function sanitizeHashtags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((t) => String(t).replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    .slice(0, 5);
}

function hashText(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

// =====================================================================
// Viewer-retention signals — "why a viewer stops scrolling"
// Text-only proxies for the three things a clip needs (an open question,
// a reason to care, nothing in the way), for what the ending makes viewers
// do, and for the 30-second gut check. They cap, penalize and log; they
// never hard-reject, because every signal here can fire on innocent text.
// =====================================================================

// A reason to care: stakes — money, danger, embarrassment, relationships.
const STAKES_RE = /\b(lost|loses|losing|fired|quit|sued|arrested|jail|police|hospital|died|death|crash|hurt|bleeding|embarrassed|embarrassing|humiliating|humiliated|caught|exposed|rejected|dumped|broke|debt|fined|bet|dare|divorce|homeless)\b/i;
const MONEY_RE = /\$\s?\d|\b\d+\s?(dollars|bucks|grand|thousand|million|billion|k)\b|\b(money|cash|salary|rent)\b/i;
// A reason to care: a strong feeling.
const FEELING_RE = /\b(cries|crying|cried|tears|screaming|screamed|yelling|yelled|shocked|speechless|stunned|insane|crazy|wild|unbelievable|furious|terrified|scared|panicked|anxious|hate|hates|hatred|love|loved|loves)\b|can'?t believe/i;
// A reason to care: something useful.
const USEFUL_RE = /\b(how to|the trick|the hack|stop (doing|using|buying)|most people|mistakes?|steps?|hack|tip|method|the reason|did you know|pro tip|the secret)\b/i;
// An open question: WH-word, a question mark, or a direct question at the viewer.
const OPEN_QUESTION_RE = /\b(what|why|how|who|when|where|which)\b|\?/i;
const QUESTION_ENG_RE = /\b(did you|have you|do you|would you|could you|can you|will you|are you)\b/i;
// Comment bait — "they disagree, or there's something left to argue about".
const ARGUE_RE = /\b(always|never|nobody|everyone|everybody|no one|unpopular opinion|the only|overrated|underrated|wrong about)\b/i;
// Who's talking — self-introduction or a named person.
const SELF_INTRO_RE = /\b(im|i am|my names|my name is|call me)\b/;
const CARE_KINDS = new Set(["stakes", "recognition", "strong_feeling", "useful"]);
const ENDING_ACTIONS = new Set(["rewatch", "share", "save", "comment", "follow"]);

/** A capitalized mid-sentence token = a person or brand the viewer might recognize. */
function namedPersonInWords(words) {
  let prevTerminal = false;
  for (let i = 0; i < words.length; i++) {
    const raw = String(words[i]?.word ?? words[i]?.text ?? words[i] ?? "");
    const core = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const startsSentence = i === 0 || prevTerminal;
    prevTerminal = TERMINAL_RE.test(raw);
    if (!core || startsSentence) continue;
    const low = normalize(core);
    if (/^\p{Lu}/u.test(core) && core.length > 1 && !PRONOUN_I_RE.test(low) && !STOPWORDS.has(low)) return core;
  }
  return null;
}

/** Which "reason to care" signals fire in the given words. */
function detectCareSignal(words) {
  const text = words.map((w) => String(w?.word ?? w?.text ?? w ?? "")).join(" ");
  const kinds = [];
  if (MONEY_RE.test(text) || STAKES_RE.test(text)) kinds.push("stakes");
  if (FEELING_RE.test(text)) kinds.push("strong_feeling");
  if (USEFUL_RE.test(text)) kinds.push("useful");
  const person = namedPersonInWords(words);
  if (person) kinds.push("recognition");
  return { found: kinds.length > 0, kinds, person };
}

/** WH-word, question mark, or a direct question to the viewer. */
function openQuestionSignal(text) {
  return OPEN_QUESTION_RE.test(text) || QUESTION_ENG_RE.test(text);
}

/** Share of repeated 4-grams in the edited words — "it repeats, rambles". */
function repeatedPhraseRatio(words, n = 4) {
  const seq = words.map((w) => normalize(w?.word ?? w?.text ?? "")).filter(Boolean);
  if (seq.length < n * 4) return 0;
  const grams = new Map();
  for (let i = 0; i + n <= seq.length; i++) {
    const g = seq.slice(i, i + n).join(" ");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let repeated = 0;
  for (const c of grams.values()) if (c > 1) repeated += c - 1;
  return repeated / grams.size;
}

// =====================================================================
// Dead-air cutting — builds the edit decision list for one clip
// =====================================================================

function cuttableFillerLen(words, i) {
  const a = normalize(words[i].word);
  if (CONFIG.CUT_FILLER_WORDS && CUT_FILLER_ONE.has(a)) return 1;
  if (CONFIG.CUT_FILLER_PHRASES && i + 1 < words.length && DENSITY_TWO.has(`${a} ${normalize(words[i + 1].word)}`)) return 2;
  return 0;
}

/**
 * Returns the source ranges to keep, plus a mapper from source time to
 * edited (output) time. floor/ceil stop padding from bleeding into the
 * neighbouring words outside the clip.
 */
function buildEditPlan(words, { floor = 0, ceil = Infinity } = {}) {
  const n = words.length;
  let segments;

  if (!CONFIG.CUT_DEAD_AIR) {
    segments = [{ start: words[0].start, end: words[n - 1].end }];
  } else {
    // 1. Mark mid-clip filler for removal (never the first or last word).
    const keep = new Array(n).fill(true);
    for (let i = 1; i < n - 1; ) {
      const len = cuttableFillerLen(words, i);
      if (len && i + len < n) {
        for (let k = 0; k < len; k++) keep[i + k] = false;
        i += len;
      } else i++;
    }
    const kept = keep.map((k, i) => (k ? i : -1)).filter((i) => i !== -1);

    // 2. Decide a cut between each pair of neighbouring kept words.
    const half = CONFIG.KEEP_GAP / 2;
    segments = [];
    let segStart = Math.max(floor, words[kept[0]].start - CONFIG.PAD_BEFORE);
    for (let j = 1; j < kept.length; j++) {
      const a = words[kept[j - 1]];
      const b = words[kept[j]];
      const removed = kept[j] - kept[j - 1] - 1;
      let cutStart;
      let cutEnd;
      if (removed > 0) {
        // Filler between a and b: cut from just after a to just before b, covering the filler.
        const r0 = words[kept[j - 1] + 1];
        const r1 = words[kept[j] - 1];
        cutStart = Math.max(a.end, Math.min(a.end + CONFIG.PAD_AFTER, r0.start));
        cutEnd = Math.min(b.start, Math.max(b.start - CONFIG.PAD_BEFORE, r1.end));
      } else if (b.start - a.end > CONFIG.GAP_COMPRESS) {
        // Long silence: keep about KEEP_GAP of it so the speech still breathes.
        cutStart = a.end + Math.max(CONFIG.PAD_AFTER, half);
        cutEnd = b.start - Math.max(CONFIG.PAD_BEFORE, half);
      } else continue;
      if (cutEnd - cutStart < CONFIG.MIN_CUT) continue; // too small to bother; filler stays
      segments.push({ start: segStart, end: cutStart });
      segStart = cutEnd;
    }
    segments.push({ start: segStart, end: Math.min(ceil, words[kept[kept.length - 1]].end + CONFIG.PAD_AFTER) });

    // 3. Merge pieces too short to read as speech.
    const merged = [segments[0]];
    for (const s of segments.slice(1)) {
      const last = merged[merged.length - 1];
      if (last.end - last.start < CONFIG.MIN_SEGMENT || s.end - s.start < CONFIG.MIN_SEGMENT) last.end = s.end;
      else merged.push({ ...s });
    }
    segments = merged;
  }

  // Source -> output time. A time inside a cut maps to the next kept frame.
  const offsets = [];
  let acc = 0;
  for (const s of segments) { offsets.push(acc); acc += s.end - s.start; }
  const toOutput = (t) => {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (t < s.start) return offsets[i];
      if (t <= s.end) return offsets[i] + (t - s.start);
    }
    return acc;
  };

  // Words that survive the edit, re-timed to the output timeline (use these for captions).
  const keptWords = words
    .filter((w) => {
      const mid = (w.start + w.end) / 2;
      return segments.some((s) => mid >= s.start && mid <= s.end);
    })
    .map((w) => ({ word: w.word, start: round3(toOutput(w.start)), end: round3(toOutput(w.end)), speaker: w.speaker ?? null }));

  const sourceDuration = segments[segments.length - 1].end - segments[0].start;
  return {
    segments: segments.map((s) => ({ start: round3(s.start), end: round3(s.end) })),
    outputDuration: acc,
    sourceDuration,
    removedSec: sourceDuration - acc,
    cuts: segments.length - 1,
    fillersRemoved: words.length - keptWords.length,
    keptWords,
    maxGapAfter: maxInternalGap(keptWords),
    toOutput,
  };
}

// =====================================================================
// Validation + scoring (V1-V13, caps, penalties, total)
// =====================================================================

function makeWindowContext(windowSentences, shared, opts) {
  const text = windowSentences.map((s) => s.text).join(" ");
  return {
    ...shared,
    ...opts,
    byNum: new Map(windowSentences.map((s) => [s.num, s])),
    windowWords: new Set(normalize(text).split(" ")),
    windowDigits: text.replace(/(\d),(?=\d)/g, "$1"),
  };
}

function evaluateCandidate(raw, ctx) {
  const startIdRaw = String(raw?.start_id ?? "");
  const endIdRaw = String(raw?.end_id ?? "");
  const reject = (reasons, note) => ({
    ok: false,
    rejection: { start_id: startIdRaw, end_id: endIdRaw, reasons, note, source: "code" },
  });

  // V1 — IDs exist in this window and are ordered
  const s0 = ctx.byNum.get(parseId(raw?.start_id));
  const s1 = ctx.byNum.get(parseId(raw?.end_id));
  if (!s0 || !s1 || s0.idx > s1.idx) return reject(["invalid_ids"], "start_id/end_id missing from this window or out of order");

  const hardFails = [];
  const flags = [];

  // V2 — map IDs to word timestamps, apply trims
  const trim = sanitizeTrimOps(raw.trim_ops);
  const spanWords = ctx.words.slice(s0.wStart, s1.wEnd + 1);
  const fillerLead = Math.min(leadingFillerCount(spanWords), CONFIG.MAX_LEADING_TRIM);
  const lead = CONFIG.AUTO_TRIM_LEADING_FILLER ? fillerLead : Math.min(trim.lead, fillerLead);
  const trail = Math.min(trim.trail, CONFIG.MAX_TRAILING_TRIM);
  const clipWords = spanWords.slice(lead, spanWords.length - trail);
  if (clipWords.length < 3) return reject(["empty_after_trim"], "trim removed nearly all words");
  if (lead > trim.lead) flags.push("auto_trimmed_leading_filler");

  // Dead-air edit plan
  const firstIdx = s0.wStart + lead;
  const lastIdx = s1.wEnd - trail;
  const plan = buildEditPlan(clipWords, {
    floor: firstIdx > 0 ? ctx.words[firstIdx - 1].end : 0,
    ceil: lastIdx + 1 < ctx.words.length ? ctx.words[lastIdx + 1].start : Infinity,
  });
  const start = plan.segments[0].start;
  const end = plan.segments[plan.segments.length - 1].end;
  const duration = plan.outputDuration; // what the viewer actually watches
  const clipSentences = ctx.sentences.slice(s0.idx, s1.idx + 1);
  const clipText = clipSentences.map((s) => s.text).join(" ");

  // V3 — duration, measured after dead air is cut
  if (ctx.enforceDuration) {
    if (duration < ctx.bounds.min - CONFIG.DURATION_SLACK) hardFails.push("below_min_duration");
    else if (duration > ctx.bounds.max + CONFIG.DURATION_SLACK) hardFails.push("above_max_duration");
  }

  // V4 — spoken hook must be verbatim from the clip
  const spoken = String(raw.hook?.spoken_text ?? "").trim();
  if (!spoken || !normalize(clipText).includes(normalize(spoken))) hardFails.push("hook_text_mismatch");

  // V5 — headline length
  let headline = String(raw.hook?.headline ?? "").replace(/\s+/g, " ").trim();
  if (!headline) hardFails.push("missing_headline");
  const headlineWords = headline.split(" ").filter(Boolean);
  if (headlineWords.length > 12) {
    headline = headlineWords.slice(0, 12).join(" ");
    flags.push("headline_truncated");
  }

  // V6 — headline facts must exist in the window
  const factProblems = headlineFactProblems(headline, ctx);
  if (factProblems.length) hardFails.push("headline_fact_mismatch");

  // [mine] housekeeping guard on the first and last sentence
  if (HOUSEKEEPING_RE.test(clipSentences[0].text) || HOUSEKEEPING_RE.test(s1.text)) hardFails.push("housekeeping");

  // Payoff sentence
  let payoff = ctx.byNum.get(parseId(raw.payoff_id));
  if (!payoff || payoff.idx < s0.idx || payoff.idx > s1.idx) {
    hardFails.push("no_payoff");
    payoff = s1;
  }

  // V7 — headline leaks the payoff
  const payoffText = ctx.sentences.slice(payoff.idx, s1.idx + 1).map((s) => s.text).join(" ");
  const leak = payoffLeakRatio(headline, payoffText);

  // V8 / V9 — payoff position on the edited timeline (cuts move the payoff earlier)
  const payoffOut = plan.toOutput(Math.max(payoff.start, clipWords[0].start));
  const payoffPct = duration > 0 ? payoffOut / duration : 0;
  const payoffInWindow = payoffOut < CONFIG.HOOK_WINDOW;

  // V10 — filler/greeting open, re-checked after trimming (overrides the model)
  const greeting = GREETING_RE.test(normalize(clipWords.slice(0, 4).map((w) => w.word).join(" ")));
  const fillerOpen = leadingFillerCount(clipWords) > 0 || greeting;

  // V11 / V12 — measured after the edit; raw values are logged for tuning
  const fillerDensity = fillerPer100(plan.keptWords);
  const maxGap = plan.maxGapAfter;
  const rawFillerDensity = fillerPer100(clipWords);
  const rawMaxGap = maxInternalGap(clipWords);

  // V13 — dangling reference
  const dangling = raw.context?.dangling_reference;
  const resolvedBy = String(raw.context?.resolved_by ?? "clip");
  const needsContext = dangling != null && String(dangling).trim() !== "" && resolvedBy === "none";

  // [mine] clean ending — in punctuated transcripts the last word must close a sentence
  const codeNoCleanEnding = ctx.punctuated && !TERMINAL_RE.test(clipWords[clipWords.length - 1].word);

  // ---- scores + caps ----
  const modelScores = {};
  for (const k of SCORE_KEYS) modelScores[k] = Math.round(clampNum(raw.scores?.[k], 0, 10));
  if (!ctx.hasProfile) modelScores.audience_fit = 5;

  const hc = raw.hook_checks ?? {};

  // ---- [theory] viewer-retention signals, computed on the edited clip ----
  // "Why a viewer stops scrolling": people watch while they still need to
  // know something. These are text-only proxies, so they cap, penalize and
  // log — they never hard-reject. Tuned via intel_json.retention.
  const archetype = ARCHETYPES.has(raw.archetype) ? raw.archetype : "unclassified";
  const hookWords = plan.keptWords.filter((w) => w.end <= CONFIG.HOOK_WINDOW);
  const hookProbe = hookWords.length > 0 ? hookWords : clipWords.slice(0, 8);
  const hookText = hookProbe.map((w) => w.word).join(" ");
  const hookOpenQuestion = openQuestionSignal(hookText) || hc.raises_open_question === true;
  const hookCare = detectCareSignal(hookProbe);
  const careClaimRaw = String(raw.hook?.reason_to_care ?? "").trim().toLowerCase();
  const hookCareClaimed = CARE_KINDS.has(careClaimRaw);
  const noCare = !hookCare.found && !hookCareClaimed;
  // "It repeats, rambles" — measured on the edited timeline.
  const repRatio = plan.keptWords.length >= CONFIG.REPETITION_MIN_WORDS ? repeatedPhraseRatio(plan.keptWords) : 0;
  // "End as soon as the last question is answered" — the wind-down is where
  // viewers swipe. Allowed: the payoff sentence plus one reaction sentence
  // of at most WIND_DOWN_MAX_SEC seconds.
  const tailSentences = Math.max(0, s1.idx - payoff.idx);
  const tailSec = tailSentences > 0 ? Math.max(0, plan.toOutput(s1.end) - plan.toOutput(payoff.end)) : 0;
  const windDown = tailSentences > CONFIG.WIND_DOWN_MAX_SENTS || tailSec > CONFIG.WIND_DOWN_MAX_SEC;

  const scores = { ...modelScores };
  const capsApplied = [];
  const cap = (key, max, why) => {
    if (scores[key] > max) { scores[key] = max; capsApplied.push(`${key}<=${max}: ${why}`); }
  };
  if (payoffInWindow) cap("hook_strength", 3, "payoff in hook window");
  if (fillerOpen) cap("hook_strength", 4, greeting ? "greeting open" : "filler open");
  if (hc.introduces_topic !== true || hc.raises_open_question !== true) cap("hook_strength", 5, "no topic or no open question");
  if (hc.concrete_detail !== true) cap("hook_strength", 7, "no concrete detail");
  // [theory] "Question but no stakes: who cares? Stakes but no question: I
  // already know how this ends." Remove either and the clip dies. A model
  // claim counts too — the text signals are the floor, not the ceiling.
  if (noCare) cap("hook_strength", CONFIG.HOOK_CARE_CAP, "no reason to care in the hook window");
  if (!hookOpenQuestion && noCare) cap("hook_strength", CONFIG.HOOK_DEAD_CAP, "no open question and no reason to care in the hook window");

  // ---- penalties ----
  const pf = raw.penalty_flags ?? {};
  const penalties = {};
  const penaltyWhy = {};
  const penalize = (key, why) => { penalties[key] = PENALTY_VALUES[key]; penaltyWhy[key] = why; };
  if (payoffPct < CONFIG.PAYOFF_MIN_POSITION) penalize("payoff_too_early", `payoff at ${Math.round(payoffPct * 100)}% of clip`);
  if (fillerDensity > CONFIG.FILLER_MAX) penalize("dead_air", `${fillerDensity.toFixed(1)} filler per 100 words after edit`);
  else if (maxGap > CONFIG.GAP_HARD) penalize("dead_air", `${maxGap.toFixed(2)} s internal gap after edit`);
  if (needsContext) penalize("needs_outside_context", `unresolved reference "${String(dangling).slice(0, 40)}"`);
  if (pf.hook_content_mismatch === true) penalize("hook_content_mismatch", "model flag");
  else if (leak > 0.5) penalize("hook_content_mismatch", `headline leaks payoff (${Math.round(leak * 100)}% overlap)`);
  if (ctx.hasProfile && pf.off_audience === true) penalize("off_audience", "model flag");
  if (pf.no_clean_ending === true) penalize("no_clean_ending", "model flag");
  else if (codeNoCleanEnding) penalize("no_clean_ending", "last word does not end a sentence");
  // [theory] "Nothing in the way" — repetition; and the wind-down, where viewers swipe.
  if (repRatio > CONFIG.REPETITION_MAX_RATIO) penalize("repeats_itself", `${Math.round(repRatio * 100)}% repeated phrases after edit`);
  if (windDown) penalize("wind_down_tail", `${tailSentences} sentence(s), ${round2(tailSec)} s after the payoff`);
  if (!hookOpenQuestion && noCare) penalize("no_reason_to_care", "hook window has no open question and no reason-to-care signal");

  // ---- total (peak-trait formula) ----
  const traits = TRAIT_KEYS.map((k) => scores[k]).sort((a, b) => b - a);
  const base =
    WEIGHTS.hook_strength * scores.hook_strength +
    WEIGHTS.peak * traits[0] +
    WEIGHTS.second * traits[1] +
    WEIGHTS.retention_flow * scores.retention_flow +
    WEIGHTS.audience_fit * scores.audience_fit;
  const penaltySum = Object.values(penalties).reduce((a, b) => a + b, 0);
  const matchedPatterns = [...new Set((Array.isArray(raw.matched_patterns) ? raw.matched_patterns : []).map(String))]
    .filter((id) => ctx.patternIds.has(id));
  const bonus = Math.min(CONFIG.PATTERN_BONUS_CAP, CONFIG.PATTERN_BONUS * matchedPatterns.length);
  const total = round2(clampNum(base - penaltySum + bonus, 0, 10));

  if (ctx.strict && hardFails.length) {
    const note = factProblems.length ? `headline names facts not in transcript: ${factProblems.join(", ")}` : hardFails.join(", ");
    return reject(hardFails, note);
  }

  const formula = FORMULAS.has(raw.hook?.formula) ? raw.hook.formula : null;
  const strongest = [...TRAIT_KEYS].sort((a, b) => scores[b] - scores[a])[0];
  const spokenHook = spoken.slice(0, 300);

  // [theory] what the ending makes them do — text proxies, logged for tuning.
  const backText = plan.keptWords.slice(Math.floor(plan.keptWords.length / 2)).map((w) => w.word).join(" ");
  const clipWordsText = clipWords.map((w) => w.word).join(" ");
  const predictedActions = {
    rewatch: (archetype === "twist" || archetype === "promise_journey_payoff") && !windDown && payoffPct >= 0.7,
    share: FEELING_RE.test(backText) || STAKES_RE.test(backText) || archetype === "emotional_peak",
    save: USEFUL_RE.test(clipWordsText) || scores.information_value >= 7 || archetype === "tip_or_myth_bust",
    comment: ARGUE_RE.test(clipWordsText) || archetype === "polarizing_take",
    follow: Boolean(hookCare.person) && SELF_INTRO_RE.test(normalize(clipWordsText)),
  };
  const sendTo = predictedActions.share ? "share"
    : predictedActions.save ? "save"
    : predictedActions.comment ? "comment"
    : predictedActions.follow ? "follow"
    : predictedActions.rewatch ? "rewatch"
    : null;

  // [theory] the 30-second gut check, computed where text allows. The one
  // check the transcript can never answer is the first frame.
  const gutCheck = {
    sound_off_first_frame: null, // invisible to transcript scoring — the edit owns face, energy, motion
    question_after_first_sentence: openQuestionSignal(clipSentences[0].text),
    who_talking_clear: Boolean(clipSentences[0].speaker) || Boolean(hookCare.person) || SELF_INTRO_RE.test(normalize(clipWordsText)),
    boring_second: maxGap > CONFIG.GAP_HARD || repRatio > CONFIG.REPETITION_MAX_RATIO,
    ending_delivers: payoffPct >= CONFIG.PAYOFF_MIN_POSITION && !windDown,
    loops_to_start: contentWords(s1.text).some((w) => contentWords(clipSentences[0].text).includes(w)),
    send_to: sendTo,
  };

  return {
    ok: true,
    clip: {
      start,
      end,
      start_id: s0.id,
      end_id: s1.id,
      archetype,
      headline: headline.slice(0, 120),
      spoken_hook: spokenHook,
      total,
      reason: String(raw.reason ?? "").slice(0, 500) || `${archetype}: strongest trait ${strongest}.`,
      hashtags: sanitizeHashtags(raw.hashtags),
      segments: plan.segments,
      output_duration: duration,
      edited_words: plan.keptWords,
      hard_fails: hardFails, // non-empty only in score_only mode
      intel_json: {
        version: "v2.1",
        start_id: s0.id,
        end_id: s1.id,
        payoff_id: payoff.id,
        archetype,
        formula,
        headline,
        spoken_hook: spokenHook,
        open_questions: (Array.isArray(raw.hook?.open_questions) ? raw.hook.open_questions : []).map(String).slice(0, 5),
        window_hash: hashText(clipSentences.map(formatLine).join("\n")),
        model_scores: modelScores,
        scores,
        caps_applied: capsApplied,
        penalties,
        penalty_reasons: penaltyWhy,
        base: round2(base),
        pattern_bonus: bonus,
        matched_patterns: matchedPatterns,
        total,
        checks: {
          duration: round2(duration),
          source_duration: round2(plan.sourceDuration),
          payoff_pct: round2(payoffPct),
          payoff_in_window: payoffInWindow,
          filler_or_greeting_open: fillerOpen,
          filler_per_100_words: round2(fillerDensity),
          max_internal_gap_sec: round2(maxGap),
          raw_filler_per_100_words: round2(rawFillerDensity),
          raw_max_internal_gap_sec: round2(rawMaxGap),
          headline_leak_ratio: round2(leak),
          leading_words_trimmed: lead,
          trailing_words_trimmed: trail,
          model_hook_checks: hc,
          model_estimates: raw.estimates ?? null,
          context: { dangling_reference: dangling ?? null, resolved_by: resolvedBy },
        },
        retention: {
          hook_open_question: hookOpenQuestion,
          hook_reason_to_care: { found: hookCare.found, kinds: hookCare.kinds, claimed: careClaimRaw || null, person: hookCare.person },
          hook_probe_words: hookProbe.length,
          repeated_phrase_ratio: round2(repRatio),
          wind_down: { sentences: tailSentences, sec: round2(tailSec), penalized: windDown },
          headline_specific: /\d/.test(headline) || Boolean(namedPersonInWords(headline.split(/\s+/).map((w) => ({ word: w })))),
          predicted_actions: predictedActions,
          model_ending_outcome: ENDING_ACTIONS.has(String(raw.ending_outcome ?? "")) ? raw.ending_outcome : null,
          gut_check: gutCheck,
          first_frame_note: "transcript scoring cannot see the first frame (face, energy, motion) — confirm in the edit",
        },
        hard_fails: hardFails,
        flags,
        trim_ops: trim.ops,
        edit: {
          segments: plan.segments,
          output_duration: round2(duration),
          removed_sec: round2(plan.removedSec),
          cuts: plan.cuts,
          fillers_removed: plan.fillersRemoved,
        },
        risks: (Array.isArray(raw.risks) ? raw.risks : [raw.risks]).filter(Boolean).map((r) => String(r).slice(0, 300)),
        config: {
          weights: WEIGHTS,
          penalty_values: PENALTY_VALUES,
          threshold: CONFIG.THRESHOLD,
          hook_window: CONFIG.HOOK_WINDOW,
          payoff_min_position: CONFIG.PAYOFF_MIN_POSITION,
          gap_compress: CONFIG.GAP_COMPRESS,
          keep_gap: CONFIG.KEEP_GAP,
          bounds: ctx.bounds,
        },
      },
    },
  };
}

// =====================================================================
// Ranking
// =====================================================================

function dedupeClips(sorted) {
  const kept = [];
  for (const clip of sorted) {
    const dup = kept.some((k) => {
      const overlap = Math.min(clip.end, k.end) - Math.max(clip.start, k.start);
      if (overlap <= 0) return false;
      const shorter = Math.min(clip.end - clip.start, k.end - k.start);
      return overlap / shorter > CONFIG.OVERLAP_LIMIT;
    });
    if (!dup) kept.push(clip);
  }
  return kept;
}

/** [mine] at most 2 of one archetype in the top 5, unless the alternative is > 1.0 lower. */
function pickWithArchetypeCap(ranked, target) {
  const cfg = CONFIG.ARCHETYPE_CAP;
  if (!cfg) return ranked.slice(0, target);
  const pool = [...ranked];
  const out = [];
  const counts = new Map();
  while (out.length < target && pool.length) {
    let i = 0;
    const top = pool[0];
    if (out.length < cfg.topN && (counts.get(top.archetype) ?? 0) >= cfg.max) {
      const alt = pool.findIndex((c) => (counts.get(c.archetype) ?? 0) < cfg.max);
      if (alt !== -1 && top.total - pool[alt].total <= cfg.margin) i = alt;
    }
    const [pick] = pool.splice(i, 1);
    out.push(pick);
    counts.set(pick.archetype, (counts.get(pick.archetype) ?? 0) + 1);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function prepare({ transcriptJson, clipLengthPref, creatorProfile, engagementPatterns }) {
  const { sentences, words, punctuated } = segmentSentences(transcriptJson?.words ?? []);
  if (sentences.length === 0) throw new Error("no transcript words to analyze");
  const patterns = (Array.isArray(engagementPatterns) ? engagementPatterns : []).filter((p) => p?.id);
  return {
    sentences,
    words,
    shared: {
      sentences,
      words,
      punctuated,
      bounds: LENGTH_BOUNDS[clipLengthPref] ?? LENGTH_BOUNDS.ai_optimized,
      hasProfile: Boolean(creatorProfile && Object.keys(creatorProfile).length),
      patternIds: new Set(patterns.map((p) => String(p.id))),
    },
    patterns,
  };
}

// =====================================================================
// Public API
// =====================================================================

/**
 * Select mode. Returns the shape analyze.js expects plus intel_json,
 * segments (dead-air edit list), output_duration and edited_words (captions).
 */
export async function detectViralClips({
  transcriptJson,
  durationSeconds,
  maxClips,
  clipLengthPref = "ai_optimized",
  creatorProfile = null,
  engagementPatterns = [],
  onDiagnostics = null,
}) {
  const { sentences, words, shared, patterns } = prepare({ transcriptJson, clipLengthPref, creatorProfile, engagementPatterns });
  const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : words[words.length - 1].end;
  const target = Math.max(1, Math.floor(Number(maxClips) || 5));
  const maxCandidates = target * CONFIG.CANDIDATE_MULTIPLIER;
  const systemPrompt = fillPrompt({ ...shared.bounds, maxCandidates });
  const chunks = chunkSentences(sentences, duration);

  const diagnostics = { modelRejected: [], codeRejected: [], belowThreshold: [], skipped: [], chunkErrors: [] };

  const perChunk = await mapLimit(chunks, CONFIG.CHUNK_CONCURRENCY, async (chunk) => {
    const window = chunks.length > 1
      ? { from_sec: Math.round(chunk.from), to_sec: Math.round(chunk.to), video_duration_sec: Math.round(duration), note: "Sentence IDs and timestamps are absolute across the full video." }
      : { video_duration_sec: Math.round(duration) };
    try {
      const userPrompt = buildRequest({ mode: "select", targetCount: target, creatorProfile, patterns, sentences: chunk.sentences, window });
      const content = await chatComplete(systemPrompt, userPrompt, {
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        temperature: CONFIG.MODEL_TEMPERATURE,
      });
      const parsed = parseResponse(content);
      diagnostics.modelRejected.push(...parsed.rejected);
      if (parsed.skipped_reason) diagnostics.skipped.push({ window, reason: parsed.skipped_reason });

      const ctx = makeWindowContext(chunk.sentences, shared, { strict: true, enforceDuration: true });
      const accepted = [];
      for (const raw of parsed.clips.slice(0, maxCandidates)) {
        const res = evaluateCandidate(raw, ctx);
        if (res.ok) accepted.push(res.clip);
        else diagnostics.codeRejected.push(res.rejection);
      }
      return accepted;
    } catch (err) {
      diagnostics.chunkErrors.push({ window, error: String(err?.message ?? err) });
      return [];
    }
  });

  if (diagnostics.chunkErrors.length === chunks.length) {
    throw new Error(`clip intelligence failed on every window: ${diagnostics.chunkErrors[0].error}`);
  }

  const candidates = perChunk.flat();
  const passing = [];
  for (const c of candidates) {
    if (c.total >= CONFIG.THRESHOLD) passing.push(c);
    else diagnostics.belowThreshold.push({ start_id: c.start_id, end_id: c.end_id, total: c.total, archetype: c.archetype });
  }
  const ranked = dedupeClips(passing.sort((a, b) => b.total - a.total));
  const picked = pickWithArchetypeCap(ranked, target);

  if (typeof onDiagnostics === "function") {
    try { onDiagnostics(diagnostics); } catch { /* diagnostics must never break analysis */ }
  }

  if (picked.length === 0) {
    const why = diagnostics.skipped[0]?.reason ?? `no candidate reached threshold ${CONFIG.THRESHOLD}`;
    const err = new Error(`clip intelligence returned no usable clips: ${why}`);
    err.diagnostics = diagnostics;
    throw err;
  }

  return picked.map((c) => ({
    start: round2(c.start),                  // outer source bounds
    end: round2(c.end),
    title: c.headline,
    hook: c.spoken_hook || c.headline,
    virality_score: Math.round(c.total * 10), // 0-10 total -> 0-100 column
    reason: c.reason,
    hashtags: c.hashtags.length > 0 ? c.hashtags : ["clipforge"],
    segments: c.segments,                    // source ranges to keep, in order
    output_duration: round2(c.output_duration),
    edited_words: c.edited_words,            // word timings on the edited timeline (for captions)
    intel_json: c.intel_json,
  }));
}

/**
 * score_only mode — for the golden set, A/B checks and re-scoring.
 * Never rejects on duration or threshold; reports hard_fails instead.
 */
export async function scoreKnownClip({
  transcriptJson,
  startId,
  endId,
  clipLengthPref = "ai_optimized",
  creatorProfile = null,
  engagementPatterns = [],
}) {
  const { sentences, shared, patterns } = prepare({ transcriptJson, clipLengthPref, creatorProfile, engagementPatterns });
  const s0 = sentences[parseId(startId) - 1];
  const s1 = sentences[parseId(endId) - 1];
  if (!s0 || !s1 || s0.idx > s1.idx) throw new Error(`invalid clip range ${startId}-${endId}`);

  // Give the model the clip plus surrounding context.
  const windowSentences = sentences.filter((s) => s.end >= s0.start - 60 && s.start <= s1.end + 30);
  const systemPrompt = fillPrompt({ ...shared.bounds, maxCandidates: 1 });
  const userPrompt = buildRequest({
    mode: "score_only",
    targetCount: 1,
    creatorProfile,
    patterns,
    sentences: windowSentences,
    clip: { start_id: s0.id, end_id: s1.id },
  });

  const content = await chatComplete(systemPrompt, userPrompt, {
    timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
    temperature: CONFIG.MODEL_TEMPERATURE,
  });
  const parsed = parseResponse(content);
  const raw = parsed.clips[0];
  if (!raw) return { scored: false, rejected: parsed.rejected, skipped_reason: parsed.skipped_reason };

  const ctx = makeWindowContext(windowSentences, shared, { strict: false, enforceDuration: false });
  const res = evaluateCandidate({ ...raw, start_id: s0.id, end_id: s1.id }, ctx);
  if (!res.ok) return { scored: false, rejected: [res.rejection] };
  return { scored: true, passes_threshold: res.clip.total >= CONFIG.THRESHOLD, ...res.clip };
}

export {
  evaluateCandidate as _evaluateCandidate,
  makeWindowContext as _makeWindowContext,
  buildEditPlan as _buildEditPlan,
};