import { createHash } from "node:crypto";
import { chatComplete } from "./zai.js";

/**
 * Clip Intelligence v2.4 — transcript-based clip selector with dead-air
 * cutting, multi-scene stitching and a hard hook gate.
 *
 * v2.4 adds best-moment scouting: after picking, the model re-surveys the
 * WHOLE transcript once per picked clip (mode: scout) with a code-ranked
 * scout_board of the strongest moments anywhere in the video, and may pull
 * in 1-2 shots that make the clip stronger — a sharper opening, the real
 * payoff, a proof moment. Code merges the shots into the clip's scene list,
 * re-runs the full validation gate on the merged edit (global context, so
 * shot IDs may come from anywhere), and keeps the merge only when the clip
 * still passes everything and does not score worse. intel_json.scout logs
 * what was proposed, what was merged and why.
 *
 * v2.3 makes the hook the gate: "the hook earns the clip". Field testing
 * showed weak hooks shipping because every hook-quality boolean was the
 * model grading itself and a dead hook could still clear the total
 * threshold on strong traits. Now the hook window is judged by code:
 * an open loop only counts with question structure (a "?", a leading
 * question word, a curiosity gap, a reversal setup, a direct challenge) —
 * the old loose WH match fired on answers like "that's how I did it";
 * announcer openings ("today I want to..."), hedges and vague words cap
 * the hook; signals that only arrive after the first 3 seconds cap it;
 * and in select mode a dead hook (no loop, no reason to care) or a final
 * hook_strength under HOOK_MIN_STRENGTH hard-rejects the clip. The model
 * also gets computed hook_candidates — transcript lines that actually
 * carry question/stakes/curiosity structure — and a hook-pick procedure
 * step, so it starts clips on gripping lines instead of scene-setting.
 *
 * v2.2 adds scene stitching: the model may keep 2-3 non-adjacent scenes
 * inside one clip and skip what it judged boring in between (a digression,
 * a repeated example, host chat, a slow stretch the payoff does not need).
 * The skipped middle becomes part of the edit decision list, so the renderer
 * cuts it out and the captions re-time to the merged timeline — one clip,
 * several scenes, nothing boring in between.
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

  // ---- hook gate — "the hook earns the clip" [mine] ----
  // A clip whose first seconds would not stop a mid-scroll viewer must not
  // ship, no matter how strong the payoff is. These gates fire in select
  // mode only; score_only reports instead of rejecting.
  HOOK_MIN_STRENGTH: 6,       // final (capped) hook_strength below this = weak_hook hard reject
  HOOK_DEAD_REJECT: true,     // no open loop AND no reason to care = dead_hook hard reject (cap 4 + penalty still logged)
  HOOK_EARLY_SEC: 3,          // the "0-1 s / first 3 seconds" swipe window — loop or care must show up here
  HOOK_LATE_SIGNAL_CAP: 7,    // loop/care only after the early window → cap hook_strength here
  HOOK_HINTS_MAX: 8,          // computed hook_candidates lines handed to the model per window

  // ---- scene stitching — skip whole boring scenes inside one clip [mine] ----
  SCENE_STITCH: true,   // let the model propose multi-scene clips (scenes array)
  MAX_SCENES: 3,        // hard cap on scenes per clip (the hook scene + up to 2 more)
  SCENE_MIN_SKIP: 2.0,  // a scene boundary must remove at least this many seconds (smaller gaps are merged away)
  SCENE_MAX_SKIP: 45,   // one skip may remove at most this many seconds — beyond that the scenes don't belong together
  SCENE_MIN_LEN: 2.5,   // each scene must span at least this many seconds (shorter ones are merged with a neighbour)

  // ---- best-moment scouting — scout the WHOLE video for shots that make a
  // picked clip stronger, then merge them into it [mine] ----
  SCOUT_SHOTS: true,        // run the scout pass on every picked clip
  SCOUT_BOARD_MAX: 40,      // candidate moments shown to the scout pass (code-ranked)
  SCOUT_MIN_LEN: 2.0,       // a scouted shot must span at least this many seconds
  SCOUT_MAX_LEN: 20,        // a scouted shot may span at most this many seconds (a shot, not an act)
  SCOUT_MAX_SKIP: 120,      // max material a scouted merge may bridge from the clip (s)
  SCOUT_MAX_ADDED_SEC: 14,  // scouting may add at most this much speaking time to one clip
};

// Hook is the gate — it gets the top weight. A clip that starts weak is the
// one the user swipes past at second 3, whatever the payoff. [mine]
const WEIGHTS = { hook_strength: 0.35, peak: 0.30, second: 0.05, retention_flow: 0.20, audience_fit: 0.10 };
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
// Capitalized but never a recognizable person — days, months. [v2.3]
const NON_PERSON_CAPS = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "));
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
- The request block gives: mode (select, score_only or scout), and optionally creator_profile, engagement_patterns and window.
- hook_candidates (when present) lists sentence IDs whose text already carries question, curiosity-gap, stakes or concrete structure, computed by code. Weigh starting clips on or one short sentence before these lines.
- In score_only mode you are given fixed start_id and end_id values. Do not search for other clips. Fill in the same fields and scores for that range and return exactly one clip.

PARAMETERS
HOOK_WINDOW = {{HOOK_WINDOW}} seconds (about 12 spoken words). MIN_DURATION = {{MIN_DURATION}} s. MAX_DURATION = {{MAX_DURATION}} s. The payoff must start at or after {{PAYOFF_MIN_POSITION}} of the clip length. MAX_CANDIDATES = {{MAX_CANDIDATES}}.
Inside a clip, silences longer than {{GAP_COMPRESS}} s and hesitation sounds (um, uh, er) are cut automatically by the editor. Count clip length as speaking time, and do not lower retention_flow for pauses that will be cut.

SCENE STITCHING (optional)
You are not limited to one contiguous run: a clip may keep 2-3 separate scenes and skip the boring material between them entirely. Use scenes when the hook and setup are strong but the direct path to the payoff is blocked by a stretch that would lose viewers: a digression, a second example that repeats the first, host chat, a tangent, or a slow story the payoff does not need.
- "scenes" is an ordered list of {start_id, end_id} runs taken from the transcript IN ORIGINAL ORDER. Never reorder, never overlap.
- Scene 1 must contain the hook. The LAST scene must contain the payoff. What the viewer sees must still be one coherent thought: each later scene must continue, not restart, the story.
- Skip at least 2 s of material per boundary (smaller gaps are pointless stutter) and never more than 45 s in one skip. 2-3 scenes total; more fragments confuse.
- Never create a cut that leaves a dangling reference ("as I said earlier", "that's why", a pronoun whose subject got skipped). If any scene starts with a reference the previous scene does not resolve, do not stitch there — set context.resolved_by to "none" and let code reject, or pick different boundaries.
- The viewer must not feel time jumped: no "back to", no "anyway", no repeated setup across the cut.
- Count duration as the speaking time of the KEPT scenes only. Set start_id/end_id to the first scene's start and the last scene's end.
- When one contiguous run already works, do NOT output scenes — a single scene is always safer.

SCOUTING PASS (mode: scout)
After clips are picked you survey the whole video again, one picked clip at a time. You receive the clip (headline, spoken hook, its scenes, the kept text with sentence IDs, how long it runs) plus a scout_board: code-ranked moments from the REST of the video that could strengthen it, and headroom_sec: how much speaking time the merged clip may still gain. Scout for shots elsewhere in the video that make THIS clip stronger, so the merged result is one clip built from the best moments with nothing boring in between.
- Return ONLY this JSON: {"add_scenes": [{"start_id": "S12", "end_id": "S14", "why": "one sentence"}], "scout_notes": "optional one-liner"}. An empty add_scenes is a valid and often correct answer — never add a shot just to fill headroom.
- Scout for, in order of value: 1) a stronger opening — a line that creates the question faster or harder than the clip's current first scene; it becomes the new scene 1 and the hook is re-verified, so only propose lines a mid-scroll stranger would stop for within 3 seconds. 2) the missing payoff — the shot elsewhere that actually delivers what the hook promises; it must land as the last scene. 3) proof or escalation — a number, demo, reaction or concrete detail that makes the existing story hit harder.
- Every shot must survive without the material between it and the clip: no dangling reference, no pronoun whose subject is skipped, no mid-story fragment whose setup stays behind. Say in "why" how the shot connects to the clip.
- A shot may sit before, between or after the clip's existing scenes — original transcript order, never overlapping, never starting after the payoff. Each shot spans 2-20 s of speaking time and the total added time stays within headroom_sec.
- The merged clip must still be one coherent thought with the hook first and the payoff last. If nothing on the board truly helps, return no shots.
- If a board entry delivers what the hook promises better than the clip's current payoff does, crown it: return its sentence as payoff_id. The merged clip must then end on that payoff — never leave the old payoff hanging after the new one.

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
Step 4a. HOOK PICK. Before fixing the start, name the 2-3 most gripping lines of the beat — lines a mid-scroll stranger would stop for. Prefer starting the clip ON one of those lines, or at most one short setup sentence before it. A scene-setting start ("so last year", "when I was younger", "let me tell you about") is the LAST resort, never the default: it spends the first seconds on context nobody asked for. If the gripping line cannot start the clip without breaking understanding, keep the earlier start but the first sentence must still carry tension or stakes.
Step 4b. Scene stitch (only when the contiguous span fails). If walking back pulls in 10+ seconds of weak material, or the direct path to the payoff crosses a digression, a repeated example or host chat, split the clip into scenes: keep the hook setup as scene 1, skip the weak stretch, keep what leads into the payoff as the next scene. Follow the SCENE STITCHING rules. If the span works contiguously, output no scenes field.
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
 0-2 greeting, filler, throat-clearing, announcer open ("today I want to...", "in this video...", "let me explain"), or no context. 3-5 on topic but flat: context-setting that states facts without creating a question, answers instead of asking, hedged openers ("I think", "maybe"), or a reason to care you cannot point to in the text. 6-8 an explicit open loop — a question the viewer now holds, a curiosity gap ("but then", "turns out", "nobody knew"), a reversal setup ("I thought..."), or a direct challenge — PLUS a concrete detail or a reason to care. 9-10 the loop AND the stakes are both live in the first 3 seconds: immediate tension, two or more open questions, no payoff, and a concrete name, number or detail in the first 12 words. Score 6+ ONLY if you can quote the exact words that create the loop. A hook that gives no open question, or no reason to care (no stakes, no recognizable person, no strong feeling, nothing useful), is a 4 or less. If a viewer would swipe within 3 seconds, it is a 4 or less.
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
- weak_hook: the hook cannot stop a mid-scroll viewer — final hook_strength under the bar. Fix the start (move it to a gripping line) or reject.
- dead_hook: the hook window has no open question or curiosity gap AND no reason to care — a viewer swipes within 3 seconds. Fix the start or reject.
- invalid_scenes: the scenes array overlaps, is out of order, or names unknown sentence IDs
- scene_skip_too_long: a single scene boundary would skip more than 45 s
- housekeeping: intros, outros, "welcome back", "before we go on", "like and subscribe", "link in the description", sponsor reads, breaks, stage logistics
- needs_outside_context: the first two sentences contain a reference no allowed start can resolve
- visual_dependent: the only interest is something the transcript cannot show
- policy_risk_hold: harassment of a private individual, hateful content, dangerous misinformation, or sexual content. Do not drop silently.

6. RULES
- Use only sentence IDs that exist in the input. Never invent text. Every quote must be verbatim.
- Do not use facts from outside the transcript.
- THE 3-SECOND SWIPE TEST. Before you return any clip, read only its first 12 words as a stranger who is mid-scroll. If those words do not force a question the stranger needs answered, or name a stake they feel, the clip FAILS — move the start to a gripping line and re-test, or put the clip in rejected. Never ship a clip that fails this test.
- Dead on arrival as openings: greetings ("hey guys"), "today I want to...", "in this video...", "let me explain...", "so basically...", announcing the topic instead of creating a question. Never start a clip on one.
- Every clip gets a one-sentence reason naming the archetype and the strongest trait.
- Set hook.reason_to_care to the strongest reason a viewer cares (or none) and ending_outcome to the strongest action the ending earns. Code verifies the care claim against the hook-window text.
- If engagement_patterns are provided, list only the IDs the clip genuinely matches in matched_patterns.
- Output valid JSON only. No commentary, no markdown.

OUTPUT SCHEMA
{
  "clips": [{
    "start_id": "S101", "end_id": "S106",
    "scenes": [{ "start_id": "S101", "end_id": "S102" }, { "start_id": "S105", "end_id": "S106" }],
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
Order clips best first. Do not output a total score.

SCOUT MODE OUTPUT SCHEMA (when mode is scout, return ONLY this)
{ "add_scenes": [{ "start_id": "S12", "end_id": "S14", "why": "one sentence on how the shot strengthens the clip and connects to it" }], "payoff_id": "optional — crown a stronger payoff found elsewhere; it must lie inside one of the kept scenes", "scout_notes": "optional one-liner" }`;

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
  // [v2.3] computed hook candidates — transcript lines that already carry
  // question / curiosity / stakes structure. Points the model at the gripping
  // lines instead of leaving it to eyeball hundreds of sentences.
  const hints = hookHints(sentences);
  if (hints.length) {
    req.hook_candidates = {
      note: "computed from this transcript: lines with question, curiosity-gap, stakes or concrete structure — weigh starting a clip on one of these lines, or at most one short sentence before it",
      ids: hints,
    };
  }
  req.transcript = transcriptBlock(sentences);
  return JSON.stringify(req, null, 2);
}

/**
 * [v2.3] Rank transcript sentences by hook structure and return the top IDs —
 * the lines a mid-scroll viewer would stop for. Pure text signals, same
 * lexicons the gate uses, so the model is pointed at lines the gate can
 * actually verify.
 */
function hookHints(sentences) {
  const scored = [];
  for (const s of sentences) {
    const text = s.text ?? "";
    let sc = 0;
    if (SENTENCE_QUESTION_RE.test(text)) sc += 2;
    if (LEADING_WH_RE.test(normalize(text.split(/\s+/)[0] ?? ""))) sc += 1.5;
    if (QUESTION_ENG_RE.test(text)) sc += 1.5;
    if (CURIOSITY_GAP_RE.test(text)) sc += 2;
    if (REVERSAL_SETUP_RE.test(text)) sc += 2;
    if (DIRECT_CHALLENGE_RE.test(text)) sc += 1.5;
    if (STAKES_RE.test(text) || MONEY_RE.test(text) || SITUATION_RE.test(text)) sc += 2;
    if (FEELING_RE.test(text)) sc += 1;
    if (USEFUL_RE.test(text)) sc += 1;
    if (SUPERLATIVE_RE.test(text)) sc += 1;
    if (/\d/.test(text)) sc += 0.5;
    if (namedPersonInWords(text.split(/\s+/).map((w) => ({ word: w })))) sc += 1;
    if (FLAT_OPEN_RE.test(text) || HOUSEKEEPING_RE.test(text) || GREETING_RE.test(normalize(text))) sc -= 2;
    if (text.split(/\s+/).length > 30) sc -= 0.5;
    if (sc >= 2) scored.push({ id: s.id, sc });
  }
  return scored
    .sort((a, b) => b.sc - a.sc)
    .slice(0, CONFIG.HOOK_HINTS_MAX)
    .map((h) => h.id);
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
// A reason to care: situational stakes — family, relationships, work, health,
// a clock. "My mom", "my boss", "the doctor", "24 hours" — lives the viewer
// can map their own onto. [v2.3]
const SITUATION_RE = /\b(my (mom|mother|dad|father|son|daughter|brother|sister|wife|husband|kid|kids|child|girlfriend|boyfriend|partner|boss|job|friend|best friend|family)|grandma|grandpa|(girlfriend|boyfriend|crush|dated|dating|married|engaged|breakup|broke up|proposal)|(doctor|hospital|diagnosed|surgery|symptoms?|painkillers)|(24 hours|last chance|deadline|by morning|final warning))\b/i;
// A reason to care: a strong feeling.
const FEELING_RE = /\b(cries|crying|cried|tears|screaming|screamed|yelling|yelled|shocked|speechless|stunned|insane|crazy|wild|unbelievable|furious|terrified|scared|panicked|anxious|hate|hates|hatred|love|loved|loves)\b|can'?t believe/i;
// A reason to care: something useful.
const USEFUL_RE = /\b(how to|the trick|the hack|stop (doing|using|buying)|most people|mistakes?|steps?|hack|tip|method|the reason|did you know|pro tip|the secret)\b/i;
// An open question: WH-word, a question mark, or a direct question at the viewer.
// [v2.3] kept for logging only — it fires on answers ("that's how I did it"),
// so it must never verify a hook on its own. Use detectOpenLoop for gates.
const OPEN_QUESTION_RE = /\b(what|why|how|who|when|where|which)\b|\?/i;
const QUESTION_ENG_RE = /\b(did you|have you|do you|would you|could you|can you|will you|are you)\b/i;
// [v2.3] An open loop, detected with structure. A hook holds a question only
// when the text actually builds one:
const SENTENCE_QUESTION_RE = /\?/;
const LEADING_WH_RE = /^(what|why|how|who|when|where|which|whose|did|do|does|is|are|was|were|have|has|had|can|could|would|will|should|isnt|arent|dont|doesnt|didnt)\b/;
// curiosity gap — the line deliberately withholds what happened next
const CURIOSITY_GAP_RE = /\b(but then|then he|then she|then they|turns out|turned out|until (he|she|they|i|one|that|the|it)|out of nowhere|suddenly|plot twist|here'?s the thing|the thing is|the crazy part|the wildest part|the worst part|the best part|guess what|you won'?t believe|nobody knew|nobody expected|no one knew|no one expected|i didn'?t know|little did|what happened (next|when|after)|wait for it|what (he|she|they|i) (said|did|found|saw)|no one told me|they don'?t tell you)\b/i;
// reversal setup — the speaker believed one thing, implying a subversion is coming
const REVERSAL_SETUP_RE = /\b(i thought|i assumed|i expected|i figured|i always believed|i was sure|everyone thought)\b/i;
// direct challenge — pokes the viewer's own behavior or belief
const DIRECT_CHALLENGE_RE = /\b(most people|everyone (thinks|does|says)|nobody (tells|talks about|knows)|stop (doing|using|buying)|the truth about|what they don'?t tell|you'?re (doing it|using it) wrong)\b/i;
// [v2.3] announcer openings — the clip announces itself instead of hooking.
const FLAT_OPEN_RE = /\b(today i|in this video|in this episode|this video is about|this episode is about|i want to (talk|show|explain)|i'?m going to (show|explain|talk)|let me (explain|show|tell)|before (i|we) (start|begin|get into)|so basically|as you (know|can see))\b/i;
// [v2.3] hedges — uncertainty in the first seconds reads as low confidence.
const HEDGE_RE = /\b(i think|i guess|i feel like|i believe|i suppose|maybe|probably|kind of|sort of|not sure|might be)\b/i;
// [v2.3] vague words — nothing concrete to picture.
const VAGUE_RE = /\b(something|someone|somebody|stuff|things|somehow|some way|some of)\b/i;
// [v2.3] superlatives and extremes — concrete hooks lean on them.
const SUPERLATIVE_RE = /\b(biggest|smallest|worst|best|first|last|only|most|least|craziest|wildest|fastest|slowest|cheapest|richest|easiest|hardest|never|always|everyone|nobody|hundred|thousand|million|billion)\b/i;
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
    if (/^\p{Lu}/u.test(core) && core.length > 1 && !PRONOUN_I_RE.test(low) && !STOPWORDS.has(low) && !NON_PERSON_CAPS.has(low)) return core;
  }
  return null;
}

/** Which "reason to care" signals fire in the given words. */
function detectCareSignal(words) {
  const text = words.map((w) => String(w?.word ?? w?.text ?? w ?? "")).join(" ");
  const kinds = [];
  if (MONEY_RE.test(text) || STAKES_RE.test(text) || SITUATION_RE.test(text)) kinds.push("stakes");
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

/**
 * [v2.3] Strict open-loop detection — the text must actually build a question
 * the viewer now holds. Replaces the loose WH match, which fired on answers
 * ("that's how I did it", "I know what you mean") and let flat hooks verify
 * themselves. `flat` means announcer structure ("today I want to...") with no
 * loop — the model's raises_open_question claim is rejected on that evidence.
 */
function detectOpenLoop({ sentencesText = "", wordsText = "", firstWord = "" }) {
  const kinds = [];
  const hay = `${sentencesText} ${wordsText}`;
  if (SENTENCE_QUESTION_RE.test(sentencesText)) kinds.push("question");
  if (firstWord && LEADING_WH_RE.test(normalize(firstWord))) kinds.push("question");
  if (QUESTION_ENG_RE.test(wordsText)) kinds.push("question");
  if (CURIOSITY_GAP_RE.test(hay)) kinds.push("curiosity_gap");
  if (REVERSAL_SETUP_RE.test(wordsText)) kinds.push("reversal_setup");
  if (DIRECT_CHALLENGE_RE.test(wordsText)) kinds.push("direct_challenge");
  return { found: kinds.length > 0, kinds: [...new Set(kinds)], flat: FLAT_OPEN_RE.test(hay) };
}

/**
 * [v2.3] Concrete detail, computed: a number, a named person, or a
 * superlative/extreme in the hook window. Used to police the model's
 * concrete_detail claim — "concrete" hooks that only contain vague words
 * (something, stuff) are not concrete.
 */
function detectConcreteDetail(words) {
  const text = words.map((w) => String(w?.word ?? w?.text ?? w ?? "")).join(" ");
  const markers = [];
  if (/\d/.test(text)) markers.push("number");
  if (SUPERLATIVE_RE.test(text)) markers.push("superlative");
  const person = namedPersonInWords(words);
  if (person) markers.push("person");
  return { found: markers.length > 0, markers, person };
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
// Scene stitching — 2-3 non-adjacent scenes merged into one clip
// =====================================================================

class SceneError extends Error {
  constructor(reason, note) {
    super(note);
    this.reason = reason;
  }
}

/**
 * Parse + normalize the model's `scenes` proposal into sentence pairs.
 * Returns null when no usable scenes were proposed (caller falls back to the
 * contiguous path). Throws SceneError (invalid_scenes | scene_skip_too_long)
 * for structurally broken proposals.
 *
 * Graceful degradation, never rejection, for merely imperfect proposals:
 * - gaps below SCENE_MIN_SKIP and scenes shorter than SCENE_MIN_LEN are merged
 *   away (the clip just plays through them),
 * - scenes beyond MAX_SCENES are dropped (flagged, not rejected).
 */
function resolveScenes(raw, ctx) {
  if (!CONFIG.SCENE_STITCH || !Array.isArray(raw?.scenes) || raw.scenes.length === 0) return null;

  const flags = [];
  const parsed = [];
  for (const sc of raw.scenes) {
    const a = ctx.byNum.get(parseId(sc?.start_id));
    const b = ctx.byNum.get(parseId(sc?.end_id));
    if (!a || !b || a.idx > b.idx) {
      throw new SceneError("invalid_scenes", `scene ${sc?.start_id}-${sc?.end_id} is missing from this window or out of order`);
    }
    parsed.push({ s0: a, s1: b });
  }
  // Order by start; overlapping scenes are a model error we cannot guess away.
  parsed.sort((x, y) => x.s0.idx - y.s0.idx);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].s0.idx <= parsed[i - 1].s1.idx) {
      throw new SceneError("invalid_scenes", "scenes overlap — they must be separate, ordered runs");
    }
  }
  let scenes = parsed;
  if (scenes.length > CONFIG.MAX_SCENES) {
    scenes = scenes.slice(0, CONFIG.MAX_SCENES);
    flags.push("scenes_truncated");
  }

  // Merge passes until stable: tiny skips and too-short scenes degrade into
  // one longer scene instead of stutter cuts.
  const gap = (a, b) => Math.max(0, b.s0.start - a.s1.end);
  const span = (s) => s.s1.end - s.s0.start;
  let merged = scenes;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const out = [merged[0]];
    for (let i = 1; i < merged.length; i++) {
      const prev = out[out.length - 1];
      const cur = merged[i];
      if (gap(prev, cur) < CONFIG.SCENE_MIN_SKIP) {
        prev.s1 = cur.s1; // skip too small to read as a cut — play through
        changed = true;
      } else if (span(cur) < CONFIG.SCENE_MIN_LEN) {
        prev.s1 = cur.s1; // scene too short to stand alone — fold into previous
        changed = true;
      } else {
        out.push(cur);
      }
    }
    // The first scene must also carry its weight.
    if (out.length > 1 && span(out[0]) < CONFIG.SCENE_MIN_LEN) {
      out.splice(0, 2, { s0: out[0].s0, s1: out[1].s1 });
      changed = true;
    }
    merged = out;
    if (!changed) break;
  }
  if (merged.length === 0) return null;

  // The skip cap normally comes from CONFIG. A scout-context window can raise
  // it (ctx.sceneMaxSkip) because scouting may bridge a much larger gap than
  // a select-mode stitch — the shots come from anywhere in the video.
  const maxSkip = Number(ctx.sceneMaxSkip) > 0 ? Number(ctx.sceneMaxSkip) : CONFIG.SCENE_MAX_SKIP;
  for (let i = 1; i < merged.length; i++) {
    if (gap(merged[i - 1], merged[i]) > maxSkip) {
      throw new SceneError("scene_skip_too_long", `scene boundary would skip more than ${Math.round(maxSkip)} s`);
    }
  }
  return { scenes: merged, flags };
}

/**
 * Multi-scene edit plan: run the dead-air edit per scene, then concatenate
 * the scene plans into one edit decision list. Kept words are re-timed onto
 * the merged (output) timeline, so captions, payoff position and the
 * retention checks all see exactly what the viewer will see.
 */
function buildSceneEditPlan(sceneList, ctx, { lead, trail }) {
  const plans = [];
  const sceneWords = [];

  sceneList.forEach((scene, i) => {
    const isFirst = i === 0;
    const isLast = i === sceneList.length - 1;
    // Padding must never bleed across a scene boundary into kept footage.
    // Interior scenes floor at the PREVIOUS scene's last word end, so the
    // standard onset pad may extend into the skip (never into kept speech).
    const prevLastEnd = isFirst
      ? scene.s0.wStart > 0 ? ctx.words[scene.s0.wStart - 1].end : 0
      : ctx.words[sceneList[i - 1].s1.wEnd].end;
    const floor = Math.min(prevLastEnd, scene.s0.start);
    const ceil = !isLast
      ? sceneList[i + 1].s0.start
      : scene.s1.wEnd + 1 < ctx.words.length ? ctx.words[scene.s1.wEnd + 1].start : Infinity;
    let words = ctx.words.slice(scene.s0.wStart, scene.s1.wEnd + 1);
    if (isFirst && lead > 0) words = words.slice(Math.min(lead, words.length - 1));
    if (isLast && trail > 0) words = words.slice(0, Math.max(1, words.length - trail));
    sceneWords.push(words);
    plans.push(buildEditPlan(words, { floor, ceil }));
  });

  // Concatenate: scene output times shift by the running output duration.
  const segments = [];
  const keptWords = [];
  const offsets = [];
  let acc = 0;
  let fillersRemoved = 0;
  plans.forEach((p, i) => {
    offsets.push(acc);
    for (const s of p.segments) segments.push(s);
    for (const w of p.keptWords) {
      keptWords.push({ ...w, start: round3(w.start + acc), end: round3(w.end + acc) });
    }
    acc += p.outputDuration;
    fillersRemoved += sceneWords[i].length - p.keptWords.length;
  });

  const sourceDuration = segments[segments.length - 1].end - segments[0].start;

  // Global source -> output mapper (times inside a skipped scene map to the
  // start of the next scene's output).
  const toOutput = (t) => {
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const first = p.segments[0];
      const last = p.segments[p.segments.length - 1];
      if (t < first.start) return offsets[i];
      if (t <= last.end) return offsets[i] + p.toOutput(t);
    }
    return acc;
  };

  return {
    segments: segments.map((s) => ({ start: round3(s.start), end: round3(s.end) })),
    outputDuration: acc,
    sourceDuration,
    removedSec: sourceDuration - acc,
    cuts: segments.length - 1,
    fillersRemoved,
    keptWords,
    maxGapAfter: maxInternalGap(keptWords),
    toOutput,
    scenePlans: plans,
  };
}

// =====================================================================
// [v2.4] Best-moment scouting — scout the WHOLE video for shots that make
// a picked clip stronger, then merge them into one clip
// =====================================================================

/**
 * Rank sentences by "moment" value — the lines anywhere in the video that
 * could strengthen a clip: reveals, numbers, emotional peaks, strong takes.
 * Pure text signals, the same lexicons the rest of the module scores with.
 * exclude = { from, to } sentence-index span of the clip itself (its own
 * material is not a candidate). Returns board entries with one neighbour of
 * context on each side so the model can size the shot boundaries.
 */
function momentHints(sentences, exclude, max = CONFIG.SCOUT_BOARD_MAX) {
  const scored = [];
  for (const s of sentences) {
    if (exclude && s.idx >= exclude.from && s.idx <= exclude.to) continue;
    const text = s.text ?? "";
    const words = text.split(/\s+/).filter(Boolean);
    let sc = 0;
    const signals = [];
    const add = (w, name) => { sc += w; signals.push(name); };
    if (FEELING_RE.test(text)) add(2, "strong_feeling");
    if (STAKES_RE.test(text)) add(2, "stakes");
    if (SITUATION_RE.test(text)) add(1.5, "situation");
    if (MONEY_RE.test(text)) add(1.5, "money");
    if (SUPERLATIVE_RE.test(text)) add(1.5, "superlative");
    if (ARGUE_RE.test(text)) add(1.5, "polarizing");
    if (USEFUL_RE.test(text)) add(1.5, "useful");
    if (DIRECT_CHALLENGE_RE.test(text)) add(1, "challenge");
    if (QUESTION_ENG_RE.test(text)) add(1, "asks_viewer");
    if (CURIOSITY_GAP_RE.test(text)) add(1, "curiosity_gap");
    if (/\d/.test(text)) add(1, "number");
    if (words.length > 32) sc -= 1;
    if (GREETING_RE.test(normalize(text)) || HOUSEKEEPING_RE.test(text) || FLAT_OPEN_RE.test(text)) sc -= 3;
    if (sc < 2) continue;
    const prev = s.idx > 0 ? sentences[s.idx - 1] : null;
    const next = s.idx + 1 < sentences.length ? sentences[s.idx + 1] : null;
    scored.push({
      id: s.id,
      t: round2(s.start),
      text: words.slice(0, 40).join(" ").slice(0, 200),
      sc: round2(sc),
      signals,
      before: prev ? { id: prev.id, text: String(prev.text ?? "").slice(0, 90) } : null,
      after: next ? { id: next.id, text: String(next.text ?? "").slice(0, 90) } : null,
    });
  }
  return scored.sort((a, b) => (b.sc - a.sc) || (a.t - b.t)).slice(0, max);
}

/**
 * Scout request: the clip (headline, hook, scenes, kept text, duration), the
 * headroom the merge may add, and the board. Kept text is listed scene by
 * scene with sentence IDs so the model can judge connectivity.
 */
function buildScoutRequest({ clip, sentences, board, headroomSec, creatorProfile, patterns }) {
  const scenes = Array.isArray(clip.intel_json?.scenes) && clip.intel_json.scenes.length >= 2
    ? clip.intel_json.scenes
    : [{ start_id: clip.start_id, end_id: clip.end_id }];
  const keptText = [];
  for (const sc of scenes) {
    const a = sentences[parseId(sc.start_id) - 1];
    const b = sentences[parseId(sc.end_id) - 1];
    if (!a || !b) continue;
    const text = sentences.slice(a.idx, b.idx + 1).map((s) => s.text).join(" ");
    keptText.push(`${sc.start_id}-${sc.end_id}: ${text.slice(0, 600)}`);
  }
  const req = {
    mode: "scout",
    clip: {
      headline: clip.headline,
      spoken_hook: clip.spoken_hook,
      duration_sec: round2(clip.output_duration),
      payoff_id: clip.intel_json?.payoff_id ?? null,
      scenes,
      kept_text: keptText,
    },
    headroom_sec: Math.max(0, round2(headroomSec)),
    scout_rules: {
      max_scenes_total: CONFIG.MAX_SCENES,
      shot_len_sec: [CONFIG.SCOUT_MIN_LEN, CONFIG.SCOUT_MAX_LEN],
      max_added_sec: round2(Math.max(0, Math.min(CONFIG.SCOUT_MAX_ADDED_SEC, headroomSec))),
      order: "original transcript order — a shot may sit before, between or after the scenes above, but scenes stay ordered and never overlap; never start a shot after the payoff",
    },
  };
  if (creatorProfile) req.creator_profile = creatorProfile;
  if (patterns.length) req.engagement_patterns = patterns;
  req.scout_board = board;
  return JSON.stringify(req, null, 2);
}

/** Same JSON extraction as parseResponse, scout envelope. */
function parseScoutResponse(content) {
  const cleaned = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const objStart = cleaned.indexOf("{");
  if (objStart === -1) throw new Error("scout response contained no JSON");
  const parsed = JSON.parse(cleaned.slice(objStart, cleaned.lastIndexOf("}") + 1));
  return {
    add_scenes: Array.isArray(parsed?.add_scenes) ? parsed.add_scenes : [],
    payoff_id: parsed?.payoff_id ? String(parsed.payoff_id) : null,
    scout_notes: parsed?.scout_notes ? String(parsed.scout_notes).slice(0, 300) : null,
  };
}

/**
 * Scout one picked clip. The model may propose up to 2 additional shots from
 * anywhere in the video (they become extra scenes); code validates them,
 * merges the scene list, re-runs the FULL validation gate on the merged edit
 * and keeps the merge only when the clip still passes and does not score
 * worse than the original. Never throws — a scout failure returns the
 * original clip untouched.
 */
async function scoutClip(clip, { sentences, shared, creatorProfile, patterns, systemPrompt, diagnostics }) {
  const setScout = (meta) => {
    clip.intel_json = { ...(clip.intel_json ?? {}), scout: { attempted: true, ...meta } };
    return clip;
  };

  try {
    const ij = clip.intel_json ?? {};
    // 1. The clip's current scenes in sentence IDs (contiguous clip = one scene).
    const curScenes = Array.isArray(ij.scenes) && ij.scenes.length >= 2
      ? ij.scenes.map((s) => ({ start_id: String(s.start_id), end_id: String(s.end_id) }))
      : [{ start_id: clip.start_id, end_id: clip.end_id }];
    const firstSent = sentences[parseId(curScenes[0].start_id) - 1];
    const lastSent = sentences[parseId(curScenes[curScenes.length - 1].end_id) - 1];
    if (!firstSent || !lastSent) return setScout({ accepted: false, why: "clip sentence IDs unresolved" });

    // 2. Board + budget. The merge may use the duration slack too, but the
    // merged clip must still clear the MAX duration check, so budget to it.
    const bounds = shared.bounds;
    const ceiling = bounds.max + CONFIG.DURATION_SLACK;
    const headroom = Math.max(0, ceiling - clip.output_duration);
    const budget = Math.min(CONFIG.SCOUT_MAX_ADDED_SEC, headroom);
    if (budget < CONFIG.SCOUT_MIN_LEN) {
      return setScout({ accepted: false, why: "no headroom left for a scouted shot", board_size: 0 });
    }
    const board = momentHints(sentences, { from: firstSent.idx, to: lastSent.idx });

    // 3. Ask the model.
    const userPrompt = buildScoutRequest({ clip, sentences, board, headroomSec: headroom, creatorProfile, patterns });
    let parsed;
    try {
      const content = await chatComplete(systemPrompt, userPrompt, {
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        temperature: CONFIG.MODEL_TEMPERATURE,
      });
      parsed = parseScoutResponse(content);
    } catch (err) {
      diagnostics.scoutErrors.push({ clip: clip.start_id, error: String(err?.message ?? err) });
      return setScout({ accepted: false, why: "scout pass failed", board_size: board.length });
    }

    // 4. Validate proposals structurally. Imperfect proposals are dropped
    // individually (logged) — only a VALID merged clip can replace the original.
    const slots = Math.max(0, CONFIG.MAX_SCENES - curScenes.length);
    const payoffSent = ij.payoff_id ? sentences[parseId(ij.payoff_id) - 1] : null;
    // A crowned payoff inside a proposed shot legitimates that shot even
    // though it starts after the old payoff — the payoff moves to it.
    const candPayoff = parsed.payoff_id ? sentences[parseId(parsed.payoff_id) - 1] : null;
    const existing = curScenes.map((sc) => ({
      s0: sentences[parseId(sc.start_id) - 1],
      s1: sentences[parseId(sc.end_id) - 1],
    })).filter((e) => e.s0 && e.s1);
    const accepted = [];
    const dropped = [];
    let addedSec = 0;
    for (const p of parsed.add_scenes) {
      const why = String(p?.why ?? "").slice(0, 200);
      const drop = (reason) => dropped.push({ start_id: p?.start_id ?? null, end_id: p?.end_id ?? null, why, reason });
      if (accepted.length >= slots) { drop("no_scene_slots_left"); continue; }
      const a = sentences[parseId(p?.start_id) - 1];
      const b = sentences[parseId(p?.end_id) - 1];
      if (!a || !b || a.idx > b.idx) { drop("unknown_or_unordered_ids"); continue; }
      if (a.idx >= firstSent.idx && b.idx <= lastSent.idx) { drop("inside_clip_already"); continue; }
      const span = b.end - a.start;
      if (span < CONFIG.SCOUT_MIN_LEN) { drop(`shot_under_${CONFIG.SCOUT_MIN_LEN}_s`); continue; }
      if (span > CONFIG.SCOUT_MAX_LEN) { drop(`shot_over_${CONFIG.SCOUT_MAX_LEN}_s`); continue; }
      if (payoffSent && a.idx > payoffSent.idx
        && !(candPayoff && a.idx <= candPayoff.idx && candPayoff.idx <= b.idx)) { drop("after_payoff"); continue; }
      if (addedSec + span > budget + 1e-9) { drop("over_budget"); continue; }
      // Must not overlap any scene (existing or already accepted) and must
      // bridge no more than SCOUT_MAX_SKIP from its nearest kept scene.
      const sceneList = [...existing, ...accepted.map((x) => ({ s0: x.a, s1: x.b }))];
      if (sceneList.some((e) => a.idx <= e.s1.idx && b.idx >= e.s0.idx)) { drop("overlaps_kept_scenes"); continue; }
      const nearestGap = Math.min(...sceneList.map((e) =>
        a.idx > e.s1.idx ? a.start - e.s1.end : e.s0.start - b.end
      ));
      if (nearestGap > CONFIG.SCOUT_MAX_SKIP) { drop("gap_too_far"); continue; }
      addedSec += span;
      accepted.push({ a, b, why, sec: round2(span) });
    }
    if (accepted.length === 0) {
      return setScout({
        accepted: false,
        why: parsed.add_scenes.length ? "no proposal passed validation" : "model found no stronger shots",
        proposed: parsed.add_scenes.length,
        dropped,
        board_size: board.length,
        scout_notes: parsed.scout_notes,
      });
    }

    // 5. Merge the scene lists (ordered by transcript position) and re-run
    // the full gate on a GLOBAL context — shot IDs may come from anywhere.
    const allScenes = [
      ...curScenes.map((sc) => ({ start_id: sc.start_id, end_id: sc.end_id, num: parseId(sc.start_id) })),
      ...accepted.map((x) => ({ start_id: x.a.id, end_id: x.b.id, num: x.a.num })),
    ].sort((x, y) => x.num - y.num);
    const mergedScenes = allScenes.map(({ start_id, end_id }) => ({ start_id, end_id }));

    // Optional payoff replacement: the model may crown a better payoff found
    // elsewhere — it must lie INSIDE one of the kept scenes; code re-verifies
    // payoff position, wind-down and headline coherence on the merged edit.
    let payoffId = ij.payoff_id ?? null;
    if (parsed.payoff_id) {
      const cand = sentences[parseId(parsed.payoff_id) - 1];
      const mergedResolved = mergedScenes.map((sc) => ({
        s0: sentences[parseId(sc.start_id) - 1],
        s1: sentences[parseId(sc.end_id) - 1],
      }));
      const inside = cand && mergedResolved.some((e) => e.s0 && e.s1 && cand.idx >= e.s0.idx && cand.idx <= e.s1.idx);
      if (inside && (!payoffSent || cand.idx !== payoffSent.idx)) {
        payoffId = cand.id;
        dropped.push({ start_id: null, end_id: null, why: "model crowned a stronger payoff", reason: `payoff_moved_to_${cand.id}` });
      } else {
        dropped.push({ start_id: parsed.payoff_id, end_id: null, why: null, reason: "invalid_payoff_id" });
      }
    }

    const ctx = makeWindowContext(sentences, shared, {
      strict: true,
      enforceDuration: true,
      sceneMaxSkip: CONFIG.SCOUT_MAX_SKIP,
    });
    // Rebuild the model's original proposal from the evaluated clip so every
    // check and score runs again on the merged edit with the same judgment.
    const modelPenaltyFlags = {};
    for (const [k, v] of Object.entries(ij.penalty_reasons ?? {})) {
      if (v === "model flag") modelPenaltyFlags[k] = true;
    }
    const raw2 = {
      start_id: curScenes[0].start_id,
      end_id: curScenes[curScenes.length - 1].end_id,
      payoff_id: payoffId,
      scenes: mergedScenes,
      archetype: ij.archetype,
      hook: {
        spoken_text: ij.spoken_hook,
        headline: ij.headline,
        formula: ij.formula ?? undefined,
        reason_to_care: ij.retention?.hook_reason_to_care?.claimed ?? "none",
        open_questions: Array.isArray(ij.open_questions) ? ij.open_questions : [],
      },
      ending_outcome: ij.retention?.model_ending_outcome ?? undefined,
      hook_checks: ij.checks?.model_hook_checks ?? {},
      context: ij.checks?.context ?? { dangling_reference: null, resolved_by: "clip" },
      trim_ops: Array.isArray(ij.trim_ops) ? ij.trim_ops : [],
      estimates: ij.checks?.model_estimates ?? undefined,
      scores: ij.model_scores,
      penalty_flags: modelPenaltyFlags,
      matched_patterns: Array.isArray(ij.matched_patterns) ? ij.matched_patterns : [],
      reason: clip.reason,
      risks: Array.isArray(ij.risks) ? ij.risks : [],
      hashtags: clip.hashtags,
    };
    let merged;
    try {
      merged = evaluateCandidate(raw2, ctx);
    } catch (err) {
      diagnostics.scoutErrors.push({ clip: clip.start_id, error: `merged eval: ${String(err?.message ?? err)}` });
      return setScout({ accepted: false, why: "merged evaluation failed", added_scenes: accepted.map(({ a, b, why: w, sec }) => ({ start_id: a.id, end_id: b.id, why: w, sec })), board_size: board.length });
    }

    const addedMeta = accepted.map(({ a, b, why: w, sec }) => ({ start_id: a.id, end_id: b.id, why: w, sec }));
    if (merged.ok && merged.clip.total >= clip.total) {
      const mc = merged.clip;
      mc.intel_json.scout = {
        attempted: true,
        accepted: true,
        why: `merged ${accepted.length} scouted shot(s) into the clip`,
        added_scenes: addedMeta,
        dropped,
        board_size: board.length,
        scout_notes: parsed.scout_notes,
      };
      return mc;
    }
    return setScout({
      accepted: false,
      why: merged.ok
        ? `merged total ${merged.clip.total} would not beat the original ${clip.total}`
        : `merged clip rejected: ${merged.rejection?.reasons?.join(", ") ?? "unknown"}`,
      added_scenes: addedMeta,
      dropped,
      board_size: board.length,
      scout_notes: parsed.scout_notes,
    });
  } catch (err) {
    diagnostics.scoutErrors.push({ clip: clip.start_id, error: String(err?.message ?? err) });
    return setScout({ accepted: false, why: "scout pass failed" });
  }
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

  const hardFails = [];
  const flags = [];

  // Scenes first — a usable `scenes` proposal overrides the contiguous span.
  // Structurally broken proposals (overlap, unknown IDs, oversized skip) reject
  // with the reason the model can fix; imperfect ones degrade gracefully.
  let sceneInfo = null;
  try {
    sceneInfo = resolveScenes(raw, ctx);
  } catch (e) {
    if (e instanceof SceneError) return reject([e.reason], e.message);
    throw e;
  }
  const useScenes = Boolean(sceneInfo && sceneInfo.scenes.length >= 2);

  // V1 — IDs exist in this window and are ordered. With scenes the span is
  // derived from the scene list, so the raw start_id/end_id pair is optional.
  const s0 = sceneInfo
    ? sceneInfo.scenes[0].s0
    : ctx.byNum.get(parseId(raw?.start_id));
  let s1 = sceneInfo
    ? sceneInfo.scenes[sceneInfo.scenes.length - 1].s1
    : ctx.byNum.get(parseId(raw?.end_id));
  if (!s0 || !s1 || s0.idx > s1.idx) return reject(["invalid_ids"], "start_id/end_id missing from this window or out of order");

  // V2 — map IDs to word timestamps, apply trims, build the edit plan
  // (dead-air cuts inside each scene + the scene skips between them).
  // Trims are span-level: leading filler sits at the very start and the
  // trailing trim at the very end, whichever branch runs below.
  const trim = sanitizeTrimOps(raw.trim_ops);
  const spanWords = ctx.words.slice(s0.wStart, s1.wEnd + 1);
  const fillerLead = Math.min(leadingFillerCount(spanWords), CONFIG.MAX_LEADING_TRIM);
  const lead = CONFIG.AUTO_TRIM_LEADING_FILLER ? fillerLead : Math.min(trim.lead, fillerLead);
  const trail = Math.min(trim.trail, CONFIG.MAX_TRAILING_TRIM);
  let clipWords;
  let plan;
  if (useScenes) {
    // The payoff must survive the stitch: scenes after the payoff's scene are
    // wind-down by definition — drop them instead of airing a dead tail. The
    // span bounds follow the edit (end_id becomes the kept last scene).
    const payoffSentence = ctx.byNum.get(parseId(raw?.payoff_id));
    if (payoffSentence) {
      const payoffSceneIdx = sceneInfo.scenes.findIndex(
        (sc) => payoffSentence.idx >= sc.s0.idx && payoffSentence.idx <= sc.s1.idx
      );
      if (payoffSceneIdx >= 0 && payoffSceneIdx < sceneInfo.scenes.length - 1) {
        sceneInfo.scenes = sceneInfo.scenes.slice(0, payoffSceneIdx + 1);
        sceneInfo.flags.push("scenes_after_payoff_dropped");
        s1 = sceneInfo.scenes[sceneInfo.scenes.length - 1].s1;
      }
    }

    plan = buildSceneEditPlan(sceneInfo.scenes, ctx, { lead, trail });
    clipWords = sceneInfo.scenes.flatMap((sc, i) => {
      let words = ctx.words.slice(sc.s0.wStart, sc.s1.wEnd + 1);
      if (i === 0 && lead > 0) words = words.slice(Math.min(lead, Math.max(0, words.length - 1)));
      if (i === sceneInfo.scenes.length - 1 && trail > 0) words = words.slice(0, Math.max(1, words.length - trail));
      return words;
    });
    flags.push("scene_stitched", ...sceneInfo.flags);
  } else {
    clipWords = spanWords.slice(lead, spanWords.length - trail);

    // Dead-air edit plan
    const firstIdx = s0.wStart + lead;
    const lastIdx = s1.wEnd - trail;
    plan = buildEditPlan(clipWords, {
      floor: firstIdx > 0 ? ctx.words[firstIdx - 1].end : 0,
      ceil: lastIdx + 1 < ctx.words.length ? ctx.words[lastIdx + 1].start : Infinity,
    });
  }
  if (clipWords.length < 3) return reject(["empty_after_trim"], "trim removed nearly all words");
  if (lead > trim.lead) flags.push("auto_trimmed_leading_filler");

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
  // log — they never hard-reject (the hook gate below is the one deliberate
  // exception). Tuned via intel_json.retention.
  const archetype = ARCHETYPES.has(raw.archetype) ? raw.archetype : "unclassified";
  const hookWords = plan.keptWords.filter((w) => w.end <= CONFIG.HOOK_WINDOW);
  const hookProbe = hookWords.length > 0 ? hookWords : clipWords.slice(0, 8);
  const hookText = hookProbe.map((w) => w.word).join(" ");
  // Sentences that start inside the hook window — clean text with punctuation,
  // so a "?" in the transcript counts as question structure.
  const hookWindowStart = Math.min(clipWords[0]?.start ?? 0, hookProbe[0]?.start ?? 0);
  const hookSentences = clipSentences.filter((s) => plan.toOutput(Math.max(s.start, hookWindowStart)) < CONFIG.HOOK_WINDOW + 0.5);
  const hookSentenceText = (hookSentences.length ? hookSentences : [clipSentences[0]]).map((s) => s.text).join(" ");
  // The early window (first ~3 s): where the 0-1 s "what is this?" and the
  // swipe decision actually happen. A loop or a stake that only shows up
  // after this is a late hook — the viewer already left.
  const earlyWords = (() => {
    const ew = plan.keptWords.filter((w) => w.end <= CONFIG.HOOK_EARLY_SEC);
    return ew.length >= 3 ? ew : plan.keptWords.slice(0, Math.min(4, plan.keptWords.length));
  })();
  const earlySentenceText = (() => {
    const es = clipSentences.filter((s) => plan.toOutput(Math.max(s.start, hookWindowStart)) < CONFIG.HOOK_EARLY_SEC + 0.25);
    return (es.length ? es : [clipSentences[0]]).map((s) => s.text).join(" ");
  })();
  const earlyText = earlyWords.map((w) => w.word).join(" ");

  // [v2.3] strict open-loop detection — question structure or nothing.
  const hookLoop = detectOpenLoop({ sentencesText: hookSentenceText, wordsText: hookText, firstWord: clipWords[0]?.word });
  const earlyLoop = detectOpenLoop({ sentencesText: earlySentenceText, wordsText: earlyText, firstWord: clipWords[0]?.word });
  const hookCare = detectCareSignal(hookProbe);
  const earlyCare = detectCareSignal(earlyWords);
  const careClaimRaw = String(raw.hook?.reason_to_care ?? "").trim().toLowerCase();
  const hookCareClaimed = CARE_KINDS.has(careClaimRaw);
  const noCare = !hookCare.found && !hookCareClaimed;
  // A raised question counts when the text shows the structure, or when the
  // model claims it AND the hook is not an announcer opening. "Today I want
  // to talk about X" claims questions all day; it still tells the viewer
  // exactly what they are about to get, so they leave.
  const hookOpenQuestion = hookLoop.found || (hc.raises_open_question === true && !hookLoop.flat);
  const questionClaimUnverified = hc.raises_open_question === true && !hookLoop.found && !hookLoop.flat;
  const flatOpen = hookLoop.flat && !hookLoop.found;
  const deadHook = !hookOpenQuestion && noCare;
  // Signal exists in the window but not in the first HOOK_EARLY_SEC — a slow
  // build the swipe never waits for.
  const lateSignal = !(earlyLoop.found || earlyCare.found) && (hookLoop.found || hookCare.found);
  const hedgedOpen = HEDGE_RE.test(earlyText);
  const hookConcrete = detectConcreteDetail(hookProbe);
  const concreteOverclaimed = hc.concrete_detail === true && !hookConcrete.found && VAGUE_RE.test(hookText);
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
  // [v2.3] announcer open — the clip announces itself instead of hooking.
  if (flatOpen) cap("hook_strength", 5, "announcer open — the clip announces itself instead of creating a question");
  if (hc.introduces_topic !== true || !hookOpenQuestion) cap("hook_strength", 5, "no topic or no open question");
  if (hc.concrete_detail !== true) cap("hook_strength", 7, "no concrete detail");
  else if (concreteOverclaimed) cap("hook_strength", 7, "concrete detail claimed but the hook words are vague");
  if (hedgedOpen) cap("hook_strength", 6, "hedged open — 'I think / maybe' in the first seconds reads as low confidence");
  // [theory] "Question but no stakes: who cares? Stakes but no question: I
  // already know how this ends." Remove either and the clip dies. A model
  // claim counts too — the text signals are the floor, not the ceiling.
  if (noCare) cap("hook_strength", CONFIG.HOOK_CARE_CAP, "no reason to care in the hook window");
  if (!hookOpenQuestion && noCare) cap("hook_strength", CONFIG.HOOK_DEAD_CAP, "no open question and no reason to care in the hook window");
  // [v2.3] slow build — the loop or the stake only arrives after the first
  // HOOK_EARLY_SEC seconds, and mid-scroll viewers do not wait that long.
  if (lateSignal) cap("hook_strength", CONFIG.HOOK_LATE_SIGNAL_CAP, `open loop or reason to care only after the first ${CONFIG.HOOK_EARLY_SEC} seconds`);

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

  // ---- [v2.3] the hook earns the clip — the gate ----
  // A clip whose first seconds would not stop a mid-scroll viewer must not
  // ship, whatever the payoff. In select mode a dead hook (no loop, no care)
  // or a final hook_strength under HOOK_MIN_STRENGTH is a hard reject; the
  // score_only path keeps reporting so the golden set can see the numbers.
  if (ctx.strict) {
    if (CONFIG.HOOK_DEAD_REJECT && deadHook) hardFails.push("dead_hook");
    if (scores.hook_strength < CONFIG.HOOK_MIN_STRENGTH) hardFails.push("weak_hook");
  }

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

  // Where one scene ends and the next begins, in source time — the skips the
  // renderer will cut. Empty for contiguous clips.
  const sceneSkips = useScenes
    ? plan.scenePlans.slice(1).map((p, i) => {
        const prev = plan.scenePlans[i];
        const skipStart = prev.segments[prev.segments.length - 1].end;
        const skipEnd = p.segments[0].start;
        return { start: round2(skipStart), end: round2(skipEnd), sec: round2(Math.max(0, skipEnd - skipStart)) };
      })
    : [];

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
        version: "v2.4",
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
          // [v2.3] strict open-loop evidence — question structure, not a loose WH match
          hook_open_loop: {
            found: hookLoop.found,
            kinds: hookLoop.kinds,
            claimed: hc.raises_open_question === true,
            claim_unverified: questionClaimUnverified,
            flat_open: flatOpen,
          },
          hook_reason_to_care: { found: hookCare.found, kinds: hookCare.kinds, claimed: careClaimRaw || null, person: hookCare.person },
          // [v2.3] the early swipe window and whether the signal arrived in time
          hook_early_window: {
            sec: CONFIG.HOOK_EARLY_SEC,
            loop: earlyLoop.found,
            care: earlyCare.found,
            late_signal: lateSignal,
            hedged_open: hedgedOpen,
          },
          hook_concrete: { found: hookConcrete.found, markers: hookConcrete.markers, claimed: hc.concrete_detail === true, overclaimed: concreteOverclaimed },
          hook_words: hookText.slice(0, 160),
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
        // Scene stitching: the scene list as actually edited (after payoff
        // drops and merges) — null when the clip is one contiguous scene.
        scenes: useScenes
          ? sceneInfo.scenes.map(({ s0: a, s1: b }) => ({ start_id: a.id, end_id: b.id }))
          : null,
        edit: {
          segments: plan.segments,
          output_duration: round2(duration),
          removed_sec: round2(plan.removedSec),
          cuts: plan.cuts,
          fillers_removed: plan.fillersRemoved,
          scene_count: useScenes ? sceneInfo.scenes.length : 1,
          scene_skips: sceneSkips,
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
  // Overlap measured on KEPT material (segments when present), so a
  // scene-stitched clip does not shadow unrelated clips that live inside its
  // skipped middle. Falls back to the plain span for legacy shapes.
  const keptRanges = (c) =>
    Array.isArray(c.segments) && c.segments.length > 0
      ? c.segments
      : [{ start: c.start, end: c.end }];
  const keptLen = (c) =>
    Number.isFinite(c.output_duration) && c.output_duration > 0
      ? c.output_duration
      : keptRanges(c).reduce((s, r) => s + (r.end - r.start), 0);
  const kept = [];
  for (const clip of sorted) {
    const dup = kept.some((k) => {
      const a = keptRanges(clip);
      const b = keptRanges(k);
      let overlap = 0;
      for (const ra of a) {
        for (const rb of b) {
          const o = Math.min(ra.end, rb.end) - Math.max(ra.start, rb.start);
          if (o > 0) overlap += o;
        }
      }
      if (overlap <= 0) return false;
      const shorter = Math.min(keptLen(clip), keptLen(k));
      return shorter > 0 && overlap / shorter > CONFIG.OVERLAP_LIMIT;
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

  const diagnostics = { modelRejected: [], codeRejected: [], belowThreshold: [], skipped: [], chunkErrors: [], scoutErrors: [] };

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
  let picked = pickWithArchetypeCap(ranked, target);

  // [v2.4] Best-moment scouting — for every picked clip the model surveys the
  // WHOLE transcript once more (scout mode) and may pull in shots from
  // anywhere in the video; code merges them and re-verifies the full gate
  // before accepting. A scout failure must never lose a clip.
  if (CONFIG.SCOUT_SHOTS && picked.length > 0) {
    const scoutDeps = { sentences, shared, creatorProfile, patterns, systemPrompt, diagnostics };
    const scouted = await mapLimit(picked, CONFIG.CHUNK_CONCURRENCY, (clip) =>
      scoutClip(clip, scoutDeps).catch(() => clip)
    );
    // Scouting can make two clips share kept material — dedupe again.
    picked = dedupeClips(scouted.sort((a, b) => b.total - a.total));
    if (picked.length > target) picked = picked.slice(0, target);
  }

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
  resolveScenes as _resolveScenes,
  buildSceneEditPlan as _buildSceneEditPlan,
  hookHints as _hookHints,
  detectOpenLoop as _detectOpenLoop,
  detectConcreteDetail as _detectConcreteDetail,
  momentHints as _momentHints,
  buildScoutRequest as _buildScoutRequest,
  parseScoutResponse as _parseScoutResponse,
  scoutClip as _scoutClip,
};