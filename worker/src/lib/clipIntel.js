import { createHash } from "node:crypto";
import { chatComplete } from "./zai.js";

/**
 * Clip Intelligence v3.0 — full recode around the two-stage
 * generate-then-judge pipeline, the hard 3-second hook gate and emotion-aware
 * candidate tagging.
 *
 * THE PIPELINE (replaces the v2.x single "select" call):
 *   1. Transcribe words are split into sentences (word-level timestamps, IDs).
 *   2. Every sentence gets audio-proxy tags computed in code — [pause 2.1s],
 *      [rate:FAST], [energy:HIGH], [laughter] — from word gaps, speech rate
 *      vs the speaker's own baseline, and textual energy markers. Optional
 *      real audio signals (loudness/pitch from ffmpeg) merge in when the
 *      caller passes audioSignals; the tags ride along in the transcript the
 *      model reads, so the model sees emotion instead of guessing it.
 *   3. STAGE 1 — FINDER (cheap, per 7-minute window, recall favored): propose
 *      8-15 candidates per window. No scoring. Empty list is a valid answer.
 *   4. STAGE 2 — JUDGE (harsh, all candidates together, precision favored):
 *      reasons FIRST, then scores 1-10 on hook / emotion / clarity / payoff /
 *      share. Weights are fixed in code (30/25/20/15/10) and code computes
 *      the total — the model never sets it. The judge also classifies the
 *      hook type, the primary emotion, flags same-idea duplicates, picks the
 *      payoff sentence, writes 5 title options and 3 on-screen hook captions.
 *   5. REFINE (code): sentence snapping, filler trims, dead-air edit plan,
 *      scene stitching, payoff position, verbatim-hook check, title fact
 *      checks — everything the transcript can verify is verified here.
 *   6. HOOK GATE (hard filter): the effective hook score after code caps must
 *      clear 6 to publish at all, and anything under 7 is rescued before it
 *      ships — (a) restart the clip on a stronger computed line, or
 *      (b) cold-open: start the clip right on the strongest line inside it.
 *      Nothing survives as "great middle, dead opening".
 *   7. RANK: a hook under 6 cannot rank in the top picks regardless of the
 *      total; same-idea duplicates and kept-material overlaps dedupe; at most
 *      2 of one clip type in the top 5.
 *   8. SCOUT (kept from v2.4): every picked clip gets one whole-video survey
 *      that may merge in 1-2 shots that make it stronger; code re-verifies.
 *   9. PACKAGE: title, spoken hook, hashtags, hook_captions, virality score,
 *      intel_json (edit decision list the renderer consumes).
 *
 * PRESERVED FROM v2.x (proven machinery, user-facing features):
 *   sentence segmentation + ID mapping, dead-air cutting, multi-scene
 *   stitching, best-moment scouting, the retention model (open loop / reason
 *   to care / wind-down / repetition / gut check), the strict hook gate,
 *   dedupe on kept ranges, intel_json.edit.segments renderer contract, and
 *   the detectViralClips / scoreKnownClip public signatures.
 *
 * The model never sees raw timestamps — it returns sentence IDs and code
 * converts them. Structured JSON only, validated in code. The model is told
 * "nothing good here is a valid answer" and examples calibrate its taste.
 *
 * Every number tagged [mine] is a starting default — retune from intel_json.
 */

// ---------- configuration ([mine] unless noted) ----------
export const CONFIG = {
  HOOK_WINDOW: 5,                 // seconds — hook window used by code checks
  HOOK_EARLY_SEC: 3,              // the swipe window — loop or care must show up here
  PAYOFF_MIN_POSITION: 0.6,       // payoff starts at >= 60% of clip — [mine]
  GAP_COMPRESS: 0.8,              // silences above this are cut down to KEEP_GAP
  GAP_HARD: 2.0,                  // any internal gap above this (after editing) = dead_air
  FILLER_MAX: 8,                  // filler words per 100 words (after editing) before dead_air
  THRESHOLD: 6.0,                 // minimum weighted total to ship (harsh judge scale)
  OVERLAP_LIMIT: 0.2,             // dedupe when overlap > 20% of the shorter clip
  // [A] 5-8 minute windows with 30-60 s overlap; equal candidate quotas per
  // window so a long video's back half is not ignored.
  WINDOW: 420,                    // 7-minute analysis windows [mine, in [A]'s 5-8 range]
  WINDOW_OVERLAP: 45,             // 45-second overlap [mine, in [A]'s 30-60 range]
  FINDER_MIN_PER_CHUNK: 8,        // [A] "propose 8-15 per chunk"
  FINDER_MAX_PER_CHUNK: 15,
  // Judge batches must fit the model's output budget. Each scorecard the
  // judge returns (reasoning + 5 dimension scores + enums + 5 titles + 3
  // hook captions) costs ~200-250 output tokens, so 60 candidates per call
  // need ~15K tokens — the response gets TRUNCATED mid-JSON, every batch
  // fails to parse, all candidates go unjudged, and analysis collapses to
  // the placeholder fallback. 20 × ~250 ≈ 5K tokens fits the 8192-token
  // budget chatComplete now sends explicitly.
  JUDGE_BATCH_MAX: 20,
  CHUNK_CONCURRENCY: 3,
  TRANSCRIPT_CHAR_CAP: 120_000,
  MODEL_TIMEOUT_MS: 240_000,
  MODEL_TEMPERATURE: 0.2,         // [A] 0-0.3 for scoring and boundaries
  ARCHETYPE_CAP: { max: 2, topN: 5, margin: 1.0 }, // at most 2 of one clip type in the top 5 — set to null to disable

  // ---- scoring: hook and emotion dominate [A] ----
  WEIGHTS: { hook: 0.3, emotion: 0.25, clarity: 0.2, payoff: 0.15, share: 0.1 },
  // A clip whose hook scores under 6 cannot rank in the top picks, whatever
  // the rest of its scores. Under 7 it gets rescued before it ships.
  HOOK_MIN_STRENGTH: 6,           // hard publish bar (rank + gate)
  HOOK_GATE_RESCUE_BELOW: 7,      // below this the gate tries to fix the opening
  TITLE_MAX_WORDS: 8,             // [A] titles under 8 words
  HOOK_CAPTION_MIN_WORDS: 3,      // [A] on-screen hook captions 3-7 words
  HOOK_CAPTION_MAX_WORDS: 7,
  PATTERN_BONUS: 0.5,             // per matched engagement pattern
  PATTERN_BONUS_CAP: 1.0,
  DURATION_SLACK: 1.0,            // tolerance on MIN/MAX since cuts land on sentence edges
  AUTO_TRIM_LEADING_FILLER: true, // trim leading filler even if the model forgot to
  MAX_LEADING_TRIM: 4,
  MAX_TRAILING_TRIM: 6,
  SEG_SILENCE: 0.6,               // split unpunctuated transcripts at silences >= this
  SEG_MAX_WORDS_UNPUNCTUATED: 25,
  SEG_MAX_WORDS_PUNCTUATED: 60,   // safety cap for run-on sentences

  // ---- dead-air cutting [mine] ----
  CUT_DEAD_AIR: true,
  KEEP_GAP: 0.25,
  PAD_BEFORE: 0.08,
  PAD_AFTER: 0.12,
  MIN_CUT: 0.3,
  MIN_SEGMENT: 0.25,
  CUT_FILLER_WORDS: true,
  CUT_FILLER_PHRASES: false,

  // ---- emotion tagging — [A] "detect it from audio too" ----
  // The default tags are text/timing proxies computed from the transcript
  // itself (pauses, speech rate vs the speaker's own baseline, energy
  // markers, laughter/applause tokens). Real loudness/pitch signals can be
  // merged in via the audioSignals parameter — see computeEmotionTags.
  PAUSE_TAG_MIN: 0.8,             // silence before a line >= this becomes [pause Xs]
  RATE_FAST: 1.35,                // wps >= 1.35 x the speaker's own median = [rate:FAST]
  RATE_SLOW: 0.65,                // wps <= 0.65 x baseline = [rate:SLOW]
  LOUDNESS_SPIKE_DB: 3.0,         // audioSignals loudness delta >= this = [energy:HIGH]
  PITCH_WIDE_SEMITONES: 4.0,      // audioSignals pitch range >= this = [pitch:WIDE]
  // [A] "a clip that is only a peak with no setup feels random" — an emotional
  // clip needs buildup before the peak lands.
  EMOTION_BUILDUP_MIN_SEC: 4,     // peak must land at least this deep into the clip
  PEAK_NO_BUILDUP_CAP: 6,         // emotion score cap when the peak has no buildup

  // ---- viewer-retention model — "why a viewer stops scrolling" [mine] ----
  WIND_DOWN_MAX_SEC: 4,
  WIND_DOWN_MAX_SENTS: 1,
  REPETITION_MAX_RATIO: 0.12,
  REPETITION_MIN_WORDS: 16,
  HOOK_CARE_CAP: 6,               // hook cap when the hook window has no reason to care
  HOOK_DEAD_CAP: 4,               // hook cap when it has neither an open question nor care

  // ---- hook gate — "the hook earns the clip" [mine] ----
  HOOK_DEAD_REJECT: true,         // no open loop AND no reason to care = hard reject
  HOOK_LATE_SIGNAL_CAP: 7,        // loop/care only after the early window → cap here
  HOOK_HINTS_MAX: 8,              // computed hook lines handed to finder/judge per window
  HOOK_RESCUE_MAX_TRIES: 3,       // code rescue attempts per path (start shift / cold open)

  // ---- scene stitching — skip whole boring scenes inside one clip [mine] ----
  SCENE_STITCH: true,
  MAX_SCENES: 5,
  SCENE_MIN_SKIP: 2.0,
  SCENE_MAX_SKIP: 45,
  SCENE_MIN_LEN: 2.5,

  // ---- best-moment scouting / multi-moment merge ----
  // v3.1: the scout is a composer — it may merge up to MAX_SCENES-1 scouted
  // moments from anywhere in the video into one clip (montage), not just
  // patch a missing opening/payoff. Limits bound how far material may sit
  // from the clip and how much speaking time may be added; the merged edit
  // is always re-judged by the full code gate before it replaces the
  // original, so a bad merge can only lose, never ship.
  SCOUT_SHOTS: true,
  SCOUT_BOARD_MAX: 60,
  SCOUT_MIN_LEN: 2.0,
  SCOUT_MAX_LEN: 30,
  SCOUT_MAX_SKIP: 240,
  SCOUT_MAX_ADDED_SEC: 30,

  // ---- creator style preferences (project "moment style" picks) ----
  STYLE_BONUS: 0.35,              // per matched style, added to the weighted total
  STYLE_BONUS_CAP: 0.7,
};

// [A] weights — hook and emotion dominate. Code applies them; the judge only
// scores 1-10 per dimension.
const WEIGHTS = CONFIG.WEIGHTS;
const PENALTY_VALUES = {
  payoff_too_early: 2,
  dead_air: 1,
  needs_outside_context: 2,
  hook_content_mismatch: 3,
  off_audience: 1.5,
  no_clean_ending: 3,
  wind_down_tail: 1,
  repeats_itself: 1,
  no_reason_to_care: 1.5,
};

const LENGTH_BOUNDS = {
  "10-14": { min: 10, max: 14 },
  "15-30": { min: 15, max: 30 },
  "31-45": { min: 31, max: 45 },
  "60+": { min: 60, max: 90 },
  ai_optimized: { min: 20, max: 60 }, // spec defaults
};

// [A] candidate types — what the finder labels, what the type cap uses.
const CLIP_TYPES = new Set(["story", "hot_take", "insight", "humor", "emotional", "controversy", "how_to"]);
// [A] hook types — the judge classifies; "none" means the opening is not a hook.
const HOOK_TYPES = new Set(["bold_claim", "curiosity_gap", "direct_question", "conflict_confession", "shocking_fact", "mid_action", "none"]);
// [A] emotion types — "don't ask for emotional clips, give the AI a list".
const EMOTION_TYPES = new Set(["surprise", "humor", "outrage", "vulnerability", "inspiration", "tension", "awe", "none"]);

// Creator style preferences — the New Project page's "style of the project"
// picks. Each style maps onto the clip types / emotions the finder and judge
// already speak, so preference biasing rides the existing rubric instead of
// inventing a parallel taxonomy. The prompts carry the intent; code adds a
// small, capped ranking bonus when a clip actually delivers the feel.
export const MOMENT_STYLES = {
  funny:          { label: "Funny",           types: ["humor"],                    emotions: ["humor", "surprise"] },
  wholesome:      { label: "Wholesome",       types: ["story"],                    emotions: ["inspiration", "vulnerability"] },
  sad:            { label: "Sad & emotional", types: ["emotional", "story"],       emotions: ["vulnerability", "tension"] },
  hype:           { label: "Hype",            types: ["hot_take"],                 emotions: ["surprise", "awe"] },
  inspiring:      { label: "Inspiring",       types: ["how_to", "story"],          emotions: ["inspiration"] },
  dramatic:       { label: "Dramatic",        types: ["controversy", "story"],     emotions: ["tension"] },
  informative:    { label: "Informative",     types: ["insight", "how_to"],        emotions: ["awe"] },
  controversial:  { label: "Controversial",   types: ["controversy", "hot_take"],  emotions: ["outrage"] },
};
const STYLE_KEYS = Object.keys(MOMENT_STYLES);
const STYLE_MAX = 4;

/** Whitelist + cap user-chosen styles (unknown keys dropped, deduped, max 4). */
export function normalizeStylePrefs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const key = String(v ?? "").trim().toLowerCase();
    if (STYLE_KEYS.includes(key) && !out.includes(key)) out.push(key);
    if (out.length >= STYLE_MAX) break;
  }
  return out;
}

/** Prompt paragraph for the requested styles — "" when none are set. */
function styleNote(styles) {
  if (!Array.isArray(styles) || styles.length === 0) return "";
  const labels = styles.map((k) => MOMENT_STYLES[k].label).join(", ");
  return `CREATOR STYLE FOCUS: the creator asked for moments that feel like: ${labels}. Favor candidates that genuinely deliver those feelings, and mark their type and primary_emotion honestly. Still surface other exceptional moments, but style-matched candidates win ties and get priority when the clip count is limited.`;
}

const JUDGE_SCORE_KEYS = ["hook", "emotion", "clarity", "payoff", "share"];

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
const NON_PERSON_CAPS = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "));
const STOPWORDS = new Set(("the a an and or but if then than so to of in on at by for with from up out about into over after before " +
  "is are was were be been being am do does did have has had will would can could should may might must " +
  "i you he she it we they me him her us them my your his its our their this that these those there here " +
  "what why how when where who which not no just very really all any some more most other such only own same too " +
  "said says say get got one").split(" "));

// ---------- emotion / energy markers (text + timing proxies) ----------
// Laughter, applause, gasps as literal tokens — real [laughter] events when
// the captioner wrote them out, or the speaker spelled the laugh.
const LAUGHTER_RE = /\b(haha+|hahaha|hehe+|lol|lmao|rofl|\[laughs?\]|\[laughter\]|\[giggles?\])\b/i;
const APPLAUSE_RE = /\b(\[applause\]|\[clapping\]|wooo+|whoo+)\b/i;
const GASP_RE = /\b(\[gasp\]|\[gasps\]|oh my god|omg|no way|what the)\b/i;
// Energy markers: exclamations, shouty caps, hype interjections.
const HYPE_RE = /\b(whoa|woah|wow|insane|crazy|unbelievable|no way|let'?s go|lets go|oh my god|omg|holy|damn|dang|what!|no!)\b/i;
const TRAIL_OFF_RE = /(\.\.\.|…)\s*$/;
// Genre markers for the rubric switch — [A] "a podcast, a lecture, gaming,
// and a sermon need different rubrics".
const GENRE_LEX = {
  gaming: /\b(gameplay|level up|boss fight|respawn|loadout|fps|ranked|no scope|clutch|speedrun|controller|aimbot|spawn|lobby|raid|guild|hp|mana|xp)\b/i,
  lecture: /\b(today we|in this lecture|the theorem|the formula|by definition|for example|chapter|slide|concept of|let'?s define|note that|proof of)\b/i,
  sermon: /\b(scripture|the verse|praise|blessed|the lord|gospel|psalm|amen|testimony|faith in|church)\b/i,
  interview: /\b(the guest|our guest|asked (him|her)|my question|follow[- ]up|on the show|joined (us|me)|back on the show)\b/i,
};
const GENRE_NOTES = {
  gaming: "Gaming content: mid-action starts are valid hooks; clarity means a stranger can follow the game state from the words alone; the payoff is the win, the fail or the comeback.",
  lecture: "Lecture/educational content: the payoff is the insight or the corrected misconception; cut application prompts and homework talk; a concrete number or named concept is the hook.",
  sermon: "Sermon/faith content: vulnerability and testimony lead; avoid doctrine stretches with no story; the payoff is the turn, the lesson or the resolution.",
  interview: "Interview/podcast content: alternate-speaker exchanges make strong standoff hooks; keep the question AND the answer; sponsor reads are hard rejects.",
  generic: "General talking content: judge by the standard rubric.",
};

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

// =====================================================================
// Emotion tagging — [A] "detect it from audio too", then "attach these as
// tags in the transcript the AI reads".
//
// Default signals are computed from the transcript itself (free, no ffmpeg):
//   [pause 2.1s]   — a long silence right before a key line (dramatic beat)
//   [rate:FAST]    — speech speeding up vs the speaker's own median (excitement)
//   [rate:SLOW]    — slowing down (weight, emphasis, or sadness)
//   [energy:HIGH]  — exclamations, hype interjections, shouty caps, spikes
//   [laughter] / [applause] / [gasp] — literal event tokens in the words
//
// Real audio signals merge in when the caller passes `audioSignals` — an
// object keyed by sentence number with { loudness_delta_db, pitch_range }:
//   [energy:HIGH]  — loudness spike above the speaker's own baseline
//   [pitch:WIDE]   — big pitch range (excitement, anger, surprise)
// The analysis pass that produces it lives with the transcriber; this module
// consumes it when present and degrades to text proxies when not.
// =====================================================================

function computeEmotionTags(sentences, audioSignals = null) {
  // Speaker baselines: median words-per-second per speaker, compared against
  // "the speaker's own average, not an absolute number" [A]. A calm speaker
  // speeding up slightly is a bigger moment than a loud one shouting.
  const rates = new Map(); // speaker -> [wps]
  for (const s of sentences) {
    const dur = Math.max(0.2, s.end - s.start);
    const wps = s.text.split(/\s+/).filter(Boolean).length / dur;
    const key = s.speaker ?? "_global";
    if (!rates.has(key)) rates.set(key, []);
    rates.get(key).push(wps);
  }
  const median = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const baseline = new Map();
  for (const [key, arr] of rates) baseline.set(key, median(arr) || 2.5);

  const tags = new Map(); // sentence idx -> string
  for (const s of sentences) {
    const parts = [];
    if (s.gap >= CONFIG.PAUSE_TAG_MIN) parts.push(`[pause ${s.gap.toFixed(1)}s]`);

    const dur = Math.max(0.2, s.end - s.start);
    const wps = s.text.split(/\s+/).filter(Boolean).length / dur;
    const base = baseline.get(s.speaker ?? "_global") ?? 2.5;
    if (base > 0 && wps >= base * CONFIG.RATE_FAST) parts.push("[rate:FAST]");
    else if (base > 0 && wps <= base * CONFIG.RATE_SLOW) parts.push("[rate:SLOW]");

    const audio = audioSignals && typeof audioSignals === "object" ? audioSignals[s.num] ?? audioSignals[String(s.num)] : null;
    let loud = false;
    if (audio && Number.isFinite(Number(audio.loudness_delta_db)) && Number(audio.loudness_delta_db) >= CONFIG.LOUDNESS_SPIKE_DB) {
      parts.push("[energy:HIGH]");
      loud = true;
    }
    if (audio && Number.isFinite(Number(audio.pitch_range)) && Number(audio.pitch_range) >= CONFIG.PITCH_WIDE_SEMITONES) {
      parts.push("[pitch:WIDE]");
      loud = true;
    }

    if (LAUGHTER_RE.test(s.text)) parts.push("[laughter]");
    if (APPLAUSE_RE.test(s.text)) parts.push("[applause]");
    if (GASP_RE.test(s.text)) parts.push("[gasp]");
    if (!loud) {
      const shoutyCaps = s.text.split(/\s+/).some((w) => w.length >= 3 && /^[A-Z]{3,}[!.?]*$/.test(w));
      const exclaim = /!/.test(s.text);
      if (HYPE_RE.test(s.text) || shoutyCaps || exclaim) parts.push("[energy:HIGH]");
    }
    if (parts.length) tags.set(s.idx, parts.join(" "));
  }
  return tags;
}

/** [A] "Detect the type first, then load the matching prompt variant." */
function detectGenre(sentences) {
  const text = sentences.map((s) => s.text).join(" ").slice(0, 40_000);
  let best = "generic";
  let bestCount = 0;
  for (const [genre, re] of Object.entries(GENRE_LEX)) {
    const m = text.match(new RegExp(re.source, "gi"));
    const count = m ? m.length : 0;
    if (count > bestCount) { best = genre; bestCount = count; }
  }
  return { genre: best, markers: bestCount };
}

// =====================================================================
// Prompt + request builders
// =====================================================================

function formatLine(s, tagMap = null) {
  const tag = tagMap?.get(s.idx) ? ` ${tagMap.get(s.idx)}` : "";
  return `${s.id} [${s.start.toFixed(2)}-${s.end.toFixed(2)}] gap=${s.gap.toFixed(2)}${tag}${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`;
}

/** The transcript block the model reads — with emotion tags attached. */
function transcriptBlock(sentences, tagMap = null) {
  const lines = [];
  let length = 0;
  for (const s of sentences) {
    const line = formatLine(s, tagMap);
    if (length + line.length + 1 > CONFIG.TRANSCRIPT_CHAR_CAP) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/** 5-8 minute windows with 30-60 s overlap, on sentence boundaries [A]. */
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

// ---------- STAGE 1: the finder ----------
// Recall favored: propose everything that COULD work. No scores — a later,
// harsher judge ranks. "Do not force clips" and the empty array are explicit
// so the model never invents mediocre candidates to fill a quota [A].

const FINDER_SYSTEM_PROMPT = `You are an expert short-form video editor who finds the best clips in long videos for TikTok, Reels, and Shorts. You will receive a transcript of one window of a longer video, pre-split into numbered sentences with word-level timing. Find EVERY moment in this window that could work as a standalone clip. A stricter judge will rank and cut later, so favor recall — but never invent moments the transcript does not contain.

A good clip: opens with a hook (bold claim, question, surprise, conflict), makes sense with zero prior context, covers exactly ONE idea or story, and ends on a payoff (conclusion, punchline, emotional peak). Length: {{MIN_DURATION}}-{{MAX_DURATION}} seconds of speaking time.

Reject from your proposals: intros, outros, sponsor reads, small talk, rambling, anything that depends on earlier context, anything that starts or ends mid-sentence, greetings, "today I want to talk about", host transitions.

EMOTION TAGS: lines carry computed audio signals — [pause 2.1s], [rate:FAST], [energy:HIGH], [laughter], [applause], [gasp]. Use them as strong evidence of emotional moments, but only count a moment if the words also make sense on their own. Do not label a moment emotional just because it is loud. Include the 5-10 seconds of buildup BEFORE an emotional peak so the peak lands — a clip that is only a peak with no setup feels random.

HOOK LINES: hook_candidates (when present) lists sentence IDs whose text already carries question, curiosity-gap, stakes or concrete structure. Weigh starting candidates on or one short sentence before these lines.

You must propose between {{FINDER_MIN}} and {{FINDER_MAX}} candidates IF the window has that many usable moments. If the window has fewer, propose what exists. If nothing in the window is good, return an empty array. Do not force clips.

{{STYLE_NOTE}}

Return ONLY this JSON:
{"candidates": [{
  "start_id": "S12", "end_id": "S25",
  "type": "story | hot_take | insight | humor | emotional | controversy | how_to",
  "summary": "one line — what the clip is about",
  "hook": "the EXACT opening sentence, copied verbatim from the transcript",
  "why": "one sentence — why a mid-scroll stranger stops",
  "hashtags": ["3 lowercase topical tags, no #"]
}]}`;

function buildFinderRequest({ sentences, tagMap, bounds, chunkMeta }) {
  const req = { mode: "find", ...chunkMeta };
  const hints = hookHints(sentences);
  if (hints.length) {
    req.hook_candidates = {
      note: "computed from this transcript: lines with question, curiosity-gap, stakes or concrete structure — weigh starting a clip on one of these lines, or at most one short sentence before it",
      ids: hints.map((h) => h.id),
    };
  }
  req.duration_bounds_sec = [bounds.min, bounds.max];
  req.transcript = transcriptBlock(sentences, tagMap);
  return JSON.stringify(req, null, 2);
}

/**
 * Parse + sanitize finder output. Recall stage, so the code gate is light:
 * known IDs, ordered span, sane length in SECONDS (raw, before dead-air cuts),
 * known type, verbatim-ish hook, max 10 hashtags... 3 actually. Duplicates
 * of an identical span collapse. Everything unusable is dropped with a reason
 * (logged), never thrown — a broken candidate must not lose the batch.
 */
function parseFinderResponse(content, sentences) {
  const cleaned = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  let parsed;
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    parsed = JSON.parse(cleaned.slice(objStart, cleaned.lastIndexOf("}") + 1));
  } else if (arrStart !== -1) {
    parsed = { candidates: JSON.parse(cleaned.slice(arrStart, cleaned.lastIndexOf("]") + 1)) };
  } else {
    throw new Error("finder response contained no JSON");
  }
  const rawList = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const byNum = new Map(sentences.map((s) => [s.num, s]));
  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of rawList.slice(0, CONFIG.FINDER_MAX_PER_CHUNK + 5)) {
    const s0 = byNum.get(parseId(raw?.start_id));
    const s1 = byNum.get(parseId(raw?.end_id));
    const drop = (reason) => dropped.push({ start_id: raw?.start_id ?? null, end_id: raw?.end_id ?? null, reason });
    if (!s0 || !s1 || s0.idx > s1.idx) { drop("unknown_or_unordered_ids"); continue; }
    const span = s1.end - s0.start;
    if (span < 3) { drop("span_under_3s"); continue; }
    if (span > 120) { drop("span_over_120s"); continue; }
    const key = `${s0.num}-${s1.num}`;
    if (seen.has(key)) { drop("duplicate_span"); continue; }
    seen.add(key);
    const hook = String(raw?.hook ?? s0.text).trim().slice(0, 400) || s0.text;
    out.push({
      s0,
      s1,
      type: CLIP_TYPES.has(String(raw?.type)) ? String(raw.type) : "story",
      summary: String(raw?.summary ?? "").trim().slice(0, 300) || s0.text.slice(0, 120),
      hook,
      why: String(raw?.why ?? "").trim().slice(0, 300),
      hashtags: sanitizeHashtags(raw?.hashtags),
    });
  }
  return { candidates: out, dropped, totalProposed: rawList.length };
}

// ---------- STAGE 2: the judge ----------
// Precision favored: ALL candidates together, scored against one rubric.
// "Be harsh. A 7 means 'I would post this.' Most candidates should score
// below 6." [A] Reasoning before score — scores come out more consistent.
// The model never computes the total; code applies the fixed weights.

const JUDGE_SYSTEM_PROMPT = `You are a strict editor choosing which clips get published on TikTok, Reels, and Shorts. You will receive candidate clips proposed from a transcript. Score every candidate, rank nothing yourself, and be harsh.

SCORE EACH CANDIDATE 1-10 (integers) on:
- hook — the FIRST 3 SECONDS (about the first 8 words) only. Instant curiosity or feeling, clarity with zero context, zero filler. A hook that starts with a greeting, "so", "um", "basically", or "today I want to talk about" is a 1-3. A hook the viewer already understands the answer to is a 3-5. A bold claim, a question the viewer needs answered, a confession, a shocking fact, or a mid-action start with stakes visible is a 7-9.
- emotion — emotional or intellectual impact. 1-3: nothing you can feel. 5: mildly engaging. 7-8: a real feeling or a genuinely surprising idea. 9-10: high-arousal, shareable, polarizing or deeply relatable. Types: surprise/shock, humor, anger/outrage, vulnerability, inspiration, tension, awe/curiosity. The strongest clips BUILD to a peak — a peak with no setup feels random, so score the emotion of the clip as the viewer will feel it, buildup included.
- clarity — self-contained: would a stranger understand it with zero context? Penalize "as I said earlier", unexplained references, pronouns with missing subjects, and any clip that needs the video around it.
- payoff — it ends on the punchline, conclusion, or emotional peak, never mid-thought, never trailing off. Also judge WHERE the payoff sits: a payoff buried in the first third of the clip is a 3-5.
- share — would someone send this to a friend? Useful (save), infuriating or hilarious (share), or neither.

WEIGHTS (applied by code, not you): hook 30%, emotion 25%, clarity 20%, payoff 15%, share 10%.

BE HARSH. A 7 means "I would post this." Most candidates should score below 6. Penalize any clip that needs context, trails off, or spends more than 5 seconds before the point.

REASONING FIRST, then scores: write "reasoning" (one or two sentences naming the strongest thing and the weakest thing) BEFORE the "scores" object.

ALSO RETURN for each candidate:
- hook_type: bold_claim | curiosity_gap | direct_question | conflict_confession | shocking_fact | mid_action | none
- primary_emotion: surprise | humor | outrage | vulnerability | inspiration | tension | awe | none
- emotion_intensity: 1-10
- payoff_id: the sentence ID where the payoff lands (answer, punchline, twist, fix, or peak)
- needs_context: true when the clip depends on material outside its own span
- same_idea: a short group label when TWO OR MORE candidates cover the same point (e.g. "taco-price-2024"); null otherwise. Code keeps only the best of each group.
- titles: EXACTLY 5 title options, each under 8 words, in these styles in order: curiosity gap, bold claim, question, number or list, emotional. Never invent facts, names or numbers not in the candidate's transcript. Never reveal the payoff. The clip must deliver whatever the title promises.
- hook_captions: EXACTLY 3 on-screen captions for the first 3 seconds, each 3-7 words. Each must create curiosity or a feeling, must be true to the clip, and must not give away the payoff.

GENRE RUBRIC: {{GENRE_NOTE}}

{{STYLE_NOTE}}

CALIBRATION EXAMPLES (taste anchors, not from this transcript):
- "hey guys welcome back to the channel" opening, decent story after: hook 2, everything else capped by the dead opening — publish no.
- "I lied to my entire team about the launch date." then the story, payoff at 70%: hook 8 (conflict_confession), emotion 7, clarity 9, payoff 8, share 7 — publish yes.
- Solid tip but the first 10 seconds are scene-setting ("so last year I was thinking about..."): hook 3-4, fix by starting at the tip — the gate will try.
- Funny moment that ends right after the laugh with no trailing chat: hook 7, emotion 8, payoff 9 — publish yes.
- Two candidates both about the same price anecdote: same_idea label on both, code keeps the better.

Return ONLY this JSON:
{"results": [{
  "id": "<the candidate id you were given>",
  "reasoning": "one or two sentences, BEFORE the scores",
  "scores": { "hook": 0, "emotion": 0, "clarity": 0, "payoff": 0, "share": 0 },
  "hook_type": "bold_claim", "primary_emotion": "surprise", "emotion_intensity": 5,
  "payoff_id": "S24", "needs_context": false, "same_idea": null,
  "titles": ["five", "options", "each", "under 8 words", "total"],
  "hook_captions": ["3-7 words", "3-7 words", "3-7 words"],
  "unfixable": false
}]}`;

function buildJudgeRequest({ candidates, sentences, tagMap, genre, creatorProfile, patterns, styles = [] }) {
  const byIdx = new Map(sentences.map((s) => [s.idx, s]));
  const items = candidates.map((c, i) => {
    // Context: two sentences on each side, so the judge can judge context
    // dependence without seeing the whole video.
    const ctxFrom = Math.max(0, c.s0.idx - 2);
    const ctxTo = Math.min(sentences.length - 1, c.s1.idx + 2);
    const context = [];
    for (let idx = ctxFrom; idx <= ctxTo; idx++) {
      const s = byIdx.get(idx) ?? sentences[idx];
      if (!s) continue;
      const mark = idx < c.s0.idx ? "BEFORE" : idx > c.s1.idx ? "AFTER" : "IN";
      context.push(`${mark} ${formatLine(s, tagMap)}`);
    }
    return {
      id: c.id,
      type: c.type,
      span: `${c.s0.id}-${c.s1.id}`,
      summary: c.summary,
      proposed_hook: c.hook,
      why: c.why,
      transcript_context: context,
    };
  });
  const req = {
    mode: "judge",
    genre: genre.genre,
    candidate_count: items.length,
    note: "Score every candidate. Be harsh — a 7 means you would post it. Reasoning first, then scores.",
    candidates: items,
  };
  if (creatorProfile) req.creator_profile = creatorProfile;
  if (patterns.length) req.engagement_patterns = patterns;
  if (Array.isArray(styles) && styles.length) {
    req.style_preferences = styles.map((k) => MOMENT_STYLES[k]?.label ?? k);
  }
  return JSON.stringify(req, null, 2);
}

/**
 * Parse + sanitize the judge's results. Missing scores = the candidate is
 * unjudged (dropped, logged) — code never invents a score the model withheld.
 */
function parseJudgeResponse(content) {
  const cleaned = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const objStart = cleaned.indexOf("{");
  if (objStart === -1) throw new Error("judge response contained no JSON");
  const parsed = JSON.parse(cleaned.slice(objStart, cleaned.lastIndexOf("}") + 1));
  const list = Array.isArray(parsed?.results) ? parsed.results : [];
  const out = new Map();
  for (const r of list) {
    const id = String(r?.id ?? "").trim();
    if (!id || out.has(id)) continue;
    const scores = {};
    let complete = true;
    for (const k of JUDGE_SCORE_KEYS) {
      const v = Math.round(Number(r?.scores?.[k]));
      if (!Number.isFinite(v) || v < 0 || v > 10) { complete = false; break; }
      scores[k] = v;
    }
    if (!complete) {
      out.set(id, { id, unjudged: true, reason: "missing_or_invalid_scores" });
      continue;
    }
    const titles = (Array.isArray(r?.titles) ? r.titles : [])
      .map((t) => String(t ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5);
    const hookCaptions = (Array.isArray(r?.hook_captions) ? r.hook_captions : [])
      .map((t) => String(t ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    out.set(id, {
      id,
      unjudged: false,
      reasoning: String(r?.reasoning ?? "").slice(0, 500),
      scores,
      hook_type: HOOK_TYPES.has(String(r?.hook_type)) ? String(r.hook_type) : "none",
      primary_emotion: EMOTION_TYPES.has(String(r?.primary_emotion)) ? String(r.primary_emotion) : "none",
      emotion_intensity: Math.round(clampNum(r?.emotion_intensity, 0, 10)),
      payoff_id: r?.payoff_id ? String(r.payoff_id) : null,
      needs_context: r?.needs_context === true,
      same_idea: r?.same_idea ? String(r.same_idea).trim().toLowerCase().slice(0, 60) : null,
      titles,
      hook_captions: hookCaptions,
      unfixable: r?.unfixable === true,
    });
  }
  return out;
}

// =====================================================================
// Text helpers (carried from v2.x)
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

/** Share of title content words that also appear in the payoff sentence(s). */
function payoffLeakRatio(title, payoffText) {
  const h = contentWords(title);
  if (h.length < 2) return 0;
  const p = new Set(contentWords(payoffText));
  return h.filter((w) => p.has(w)).length / h.length;
}

/** Every capitalized name and every number in the title must exist in the window. */
function titleFactProblems(title, ctx) {
  const tokens = title.split(/\s+/).filter(Boolean);
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
// (carried from v2.x: they cap, penalize and log; they never hard-reject —
// the hook gate is the one deliberate exception)
// =====================================================================

const STAKES_RE = /\b(lost|loses|losing|fired|quit|sued|arrested|jail|police|hospital|died|death|crash|hurt|bleeding|embarrassed|embarrassing|humiliating|humiliated|caught|exposed|rejected|dumped|broke|debt|fined|bet|dare|divorce|homeless)\b/i;
const MONEY_RE = /\$\s?\d|\b\d+\s?(dollars|bucks|grand|thousand|million|billion|k)\b|\b(money|cash|salary|rent)\b/i;
const SITUATION_RE = /\b(my (mom|mother|dad|father|son|daughter|brother|sister|wife|husband|kid|kids|child|girlfriend|boyfriend|partner|boss|job|friend|best friend|family)|grandma|grandpa|(girlfriend|boyfriend|crush|dated|dating|married|engaged|breakup|broke up|proposal)|(doctor|hospital|diagnosed|surgery|symptoms?|painkillers)|(24 hours|last chance|deadline|by morning|final warning))\b/i;
const FEELING_RE = /\b(cries|crying|cried|tears|screaming|screamed|yelling|yelled|shocked|speechless|stunned|insane|crazy|wild|unbelievable|furious|terrified|scared|panicked|anxious|hate|hates|hatred|love|loved|loves)\b|can'?t believe/i;
const USEFUL_RE = /\b(how to|the trick|the hack|stop (doing|using|buying)|most people|mistakes?|steps?|hack|tip|method|the reason|did you know|pro tip|the secret)\b/i;
const OPEN_QUESTION_RE = /\b(what|why|how|who|when|where|which)\b|\?/i;
const QUESTION_ENG_RE = /\b(did you|have you|do you|would you|could you|can you|will you|are you)\b/i;
const SENTENCE_QUESTION_RE = /\?/;
const LEADING_WH_RE = /^(what|why|how|who|when|where|which|whose|did|do|does|is|are|was|were|have|has|had|can|could|would|will|should|isnt|arent|dont|doesnt|didnt)\b/;
const CURIOSITY_GAP_RE = /\b(but then|then he|then she|then they|turns out|turned out|until (he|she|they|i|one|that|the|it)|out of nowhere|suddenly|plot twist|here'?s the thing|the thing is|the crazy part|the wildest part|the worst part|the best part|guess what|you won'?t believe|nobody knew|nobody expected|no one knew|no one expected|i didn'?t know|little did|what happened (next|when|after)|wait for it|what (he|she|they|i) (said|did|found|saw)|no one told me|they don'?t tell you)\b/i;
const REVERSAL_SETUP_RE = /\b(i thought|i assumed|i expected|i figured|i always believed|i was sure|everyone thought)\b/i;
const DIRECT_CHALLENGE_RE = /\b(most people|everyone (thinks|does|says)|nobody (tells|talks about|knows)|stop (doing|using|buying)|the truth about|what they don'?t tell|you'?re (doing it|using it) wrong)\b/i;
const FLAT_OPEN_RE = /\b(today i|in this video|in this episode|this video is about|this episode is about|i want to (talk|show|explain)|i'?m going to (show|explain|talk)|let me (explain|show|tell)|before (i|we) (start|begin|get into)|so basically|as you (know|can see))\b/i;
const HEDGE_RE = /\b(i think|i guess|i feel like|i believe|i suppose|maybe|probably|kind of|sort of|not sure|might be)\b/i;
const VAGUE_RE = /\b(something|someone|somebody|stuff|things|somehow|some way|some of)\b/i;
const SUPERLATIVE_RE = /\b(biggest|smallest|worst|best|first|last|only|most|least|craziest|wildest|fastest|slowest|cheapest|richest|easiest|hardest|never|always|everyone|nobody|hundred|thousand|million|billion)\b/i;
const ARGUE_RE = /\b(always|never|nobody|everyone|everybody|no one|unpopular opinion|the only|overrated|underrated|wrong about)\b/i;
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
 * Strict open-loop detection — the text must actually build a question the
 * viewer now holds (carried from v2.3 verbatim).
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

/** Concrete detail, computed: a number, a named person, or a superlative. */
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

/**
 * Rank transcript sentences by hook structure — the lines a mid-scroll viewer
 * would stop for (carried from v2.3). Pure text signals, the same lexicons
 * the gate uses, so rescue paths aim at lines the gate can verify.
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
    if (sc >= 2) scored.push({ id: s.id, idx: s.idx, sc });
  }
  return scored
    .sort((a, b) => b.sc - a.sc)
    .slice(0, CONFIG.HOOK_HINTS_MAX);
}

// =====================================================================
// Dead-air cutting — builds the edit decision list for one clip
// (carried from v2.x)
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
        const r0 = words[kept[j - 1] + 1];
        const r1 = words[kept[j] - 1];
        cutStart = Math.max(a.end, Math.min(a.end + CONFIG.PAD_AFTER, r0.start));
        cutEnd = Math.min(b.start, Math.max(b.start - CONFIG.PAD_BEFORE, r1.end));
      } else if (b.start - a.end > CONFIG.GAP_COMPRESS) {
        cutStart = a.end + Math.max(CONFIG.PAD_AFTER, half);
        cutEnd = b.start - Math.max(CONFIG.PAD_BEFORE, half);
      } else continue;
      if (cutEnd - cutStart < CONFIG.MIN_CUT) continue;
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
// (carried from v2.x; also powers the cold-open rescue, which is just a
// scene list that starts on a later line)
// =====================================================================

class SceneError extends Error {
  constructor(reason, note) {
    super(note);
    this.reason = reason;
  }
}

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
        prev.s1 = cur.s1;
        changed = true;
      } else if (span(cur) < CONFIG.SCENE_MIN_LEN) {
        prev.s1 = cur.s1;
        changed = true;
      } else {
        out.push(cur);
      }
    }
    if (out.length > 1 && span(out[0]) < CONFIG.SCENE_MIN_LEN) {
      out.splice(0, 2, { s0: out[0].s0, s1: out[1].s1 });
      changed = true;
    }
    merged = out;
    if (!changed) break;
  }
  if (merged.length === 0) return null;

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
 * the merged (output) timeline.
 */
function buildSceneEditPlan(sceneList, ctx, { lead, trail }) {
  const plans = [];
  const sceneWords = [];

  sceneList.forEach((scene, i) => {
    const isFirst = i === 0;
    const isLast = i === sceneList.length - 1;
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

/** Where one scene ends and the next begins, in source time (for intel_json). */
function sceneSkipList(plan) {
  if (!Array.isArray(plan.scenePlans) || plan.scenePlans.length < 2) return [];
  return plan.scenePlans.slice(1).map((p, i) => {
    const prev = plan.scenePlans[i];
    const skipStart = prev.segments[prev.segments.length - 1].end;
    const skipEnd = p.segments[0].start;
    return { start: round2(skipStart), end: round2(skipEnd), sec: round2(Math.max(0, skipEnd - skipStart)) };
  });
}

// =====================================================================
// Validation + scoring — REFINE (code owns everything verifiable)
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

/**
 * Refine one judged candidate into a publishable clip — or reject it.
 * Runs every check the transcript can verify: sentence snapping, trims,
 * dead-air edit, scenes, duration, verbatim hook, title fact-checks, payoff
 * position, retention caps, penalties, the hook gate, and the weighted total
 * (weights are code's, never the model's).
 */
function evaluateCandidate(raw, ctx) {
  const startIdRaw = String(raw?.start_id ?? "");
  const endIdRaw = String(raw?.end_id ?? "");
  const reject = (reasons, note) => ({
    ok: false,
    rejection: { start_id: startIdRaw, end_id: endIdRaw, reasons, note, source: "code" },
  });

  const hardFails = [];
  const flags = [];

  // Scenes first — a usable `scenes` proposal overrides the contiguous span
  // (multi-scene stitches AND the cold-open rescue both arrive this way).
  let sceneInfo = null;
  try {
    sceneInfo = resolveScenes(raw, ctx);
  } catch (e) {
    if (e instanceof SceneError) return reject([e.reason], e.message);
    throw e;
  }
  const useScenes = Boolean(sceneInfo && sceneInfo.scenes.length >= 2);

  const s0 = sceneInfo
    ? sceneInfo.scenes[0].s0
    : ctx.byNum.get(parseId(raw?.start_id));
  let s1 = sceneInfo
    ? sceneInfo.scenes[sceneInfo.scenes.length - 1].s1
    : ctx.byNum.get(parseId(raw?.end_id));
  if (!s0 || !s1 || s0.idx > s1.idx) return reject(["invalid_ids"], "start_id/end_id missing from this window or out of order");

  // Trims + edit plan (dead-air cuts inside each scene + scene skips between).
  const spanWords = ctx.words.slice(s0.wStart, s1.wEnd + 1);
  const fillerLead = Math.min(leadingFillerCount(spanWords), CONFIG.MAX_LEADING_TRIM);
  const lead = CONFIG.AUTO_TRIM_LEADING_FILLER ? fillerLead : 0;
  const trail = 0;
  let clipWords;
  let plan;
  if (useScenes) {
    // The payoff must survive the stitch: scenes after the payoff's scene are
    // wind-down by definition — drop them instead of airing a dead tail.
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
      return words;
    });
    flags.push("scene_stitched", ...sceneInfo.flags);
  } else {
    clipWords = spanWords.slice(lead, spanWords.length - trail);
    const firstIdx = s0.wStart + lead;
    const lastIdx = s1.wEnd - trail;
    plan = buildEditPlan(clipWords, {
      floor: firstIdx > 0 ? ctx.words[firstIdx - 1].end : 0,
      ceil: lastIdx + 1 < ctx.words.length ? ctx.words[lastIdx + 1].start : Infinity,
    });
  }
  if (clipWords.length < 3) return reject(["empty_after_trim"], "trim removed nearly all words");
  if (lead > 0) flags.push("auto_trimmed_leading_filler");

  const start = plan.segments[0].start;
  const end = plan.segments[plan.segments.length - 1].end;
  const duration = plan.outputDuration;
  const clipSentences = ctx.sentences.slice(s0.idx, s1.idx + 1);
  const clipText = clipSentences.map((s) => s.text).join(" ");

  // Duration, measured after dead air is cut
  if (ctx.enforceDuration) {
    if (duration < ctx.bounds.min - CONFIG.DURATION_SLACK) hardFails.push("below_min_duration");
    else if (duration > ctx.bounds.max + CONFIG.DURATION_SLACK) hardFails.push("above_max_duration");
  }

  // Spoken hook must be verbatim from the clip — the judge/finder claim it is
  // "the EXACT opening sentence". Soft-correct once (recall pipeline: a
  // misquoted hook should not kill a good clip), flag it for tuning.
  let spoken = String(raw.hook?.spoken_text ?? "").trim();
  if (!spoken || !normalize(clipText).includes(normalize(spoken))) {
    spoken = clipSentences[0]?.text ?? "";
    flags.push("hook_corrected");
  }

  // Housekeeping guard. LAST sentence = genuine reject (sponsor/outro tail).
  // FIRST sentence = "housekeeping_open" — rescuable: the hook gate can
  // restart the clip past a "welcome back" opening, so it must not kill the
  // candidate before the gate sees it.
  if (HOUSEKEEPING_RE.test(clipSentences[0].text)) hardFails.push("housekeeping_open");
  if (HOUSEKEEPING_RE.test(s1.text)) hardFails.push("housekeeping");

  // Payoff sentence — judge picks it; fallback is the last sentence.
  let payoff = ctx.byNum.get(parseId(raw.payoff_id));
  if (!payoff || payoff.idx < s0.idx || payoff.idx > s1.idx) {
    payoff = s1;
    flags.push("payoff_defaulted");
  }

  // ---- title selection (code picks, judge proposes) ----
  // Each option: under 8 words, only facts from the window, must not leak the
  // payoff. First option that passes all three wins; otherwise the summary's
  // first 8 words (flagged) — the pipeline never ships without a title.
  const payoffText = ctx.sentences.slice(payoff.idx, s1.idx + 1).map((s) => s.text).join(" ");
  let title = "";
  let worstTitleProblems = [];
  let proposedTitles = 0;
  let badTitles = 0;
  for (const rawTitle of (Array.isArray(raw.titles) ? raw.titles : []).slice(0, 5)) {
    const t = String(rawTitle ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    proposedTitles++;
    const words = t.split(" ").filter(Boolean);
    const trimmed = words.length > CONFIG.TITLE_MAX_WORDS ? words.slice(0, CONFIG.TITLE_MAX_WORDS).join(" ") : t;
    if (words.length > CONFIG.TITLE_MAX_WORDS) flags.push("title_truncated");
    const problems = titleFactProblems(trimmed, ctx);
    const leak = payoffLeakRatio(trimmed, payoffText);
    if (problems.length === 0 && leak <= 0.5) { title = trimmed; break; }
    badTitles++;
    if (problems.length > worstTitleProblems.length) worstTitleProblems = problems;
  }
  if (!title) {
    // Every proposed title invented facts or leaked the payoff: in strict
    // mode that is the model insisting on a dishonest title — reject so it
    // can fix the titles. Score mode keeps the summary fallback (flagged).
    if (proposedTitles > 0 && badTitles === proposedTitles) {
      hardFails.push("title_fact_mismatch");
    }
    title = String(raw.summary ?? "").replace(/\s+/g, " ").trim().split(" ").slice(0, CONFIG.TITLE_MAX_WORDS).join(" ");
    flags.push("title_fallback");
  }

  // Payoff position on the edited timeline (cuts move the payoff earlier)
  const payoffOut = plan.toOutput(Math.max(payoff.start, clipWords[0].start));
  const payoffPct = duration > 0 ? payoffOut / duration : 0;
  const payoffInWindow = payoffOut < CONFIG.HOOK_WINDOW;

  // Filler/greeting open, re-checked after trimming (overrides the model)
  const greeting = GREETING_RE.test(normalize(clipWords.slice(0, 4).map((w) => w.word).join(" ")));
  const fillerOpen = leadingFillerCount(clipWords) > 0 || greeting;

  // Measured after the edit
  const fillerDensity = fillerPer100(plan.keptWords);
  const maxGap = plan.maxGapAfter;
  const rawFillerDensity = fillerPer100(clipWords);
  const rawMaxGap = maxInternalGap(clipWords);

  // Dangling reference
  const dangling = raw.context?.dangling_reference;
  const resolvedBy = String(raw.context?.resolved_by ?? "clip");
  const needsContext =
    raw.needs_context === true ||
    (dangling != null && String(dangling).trim() !== "" && resolvedBy === "none");

  // Clean ending — in punctuated transcripts the last word must close a sentence
  const codeNoCleanEnding = ctx.punctuated && !TERMINAL_RE.test(clipWords[clipWords.length - 1].word);

  // ---- scores: the judge's, then code caps ----
  const judgeScores = {};
  for (const k of JUDGE_SCORE_KEYS) judgeScores[k] = Math.round(clampNum(raw.scores?.[k], 0, 10));
  const scores = { ...judgeScores };
  const capsApplied = [];
  const cap = (key, max, why) => {
    if (scores[key] > max) { scores[key] = max; capsApplied.push(`${key}<=${max}: ${why}`); }
  };

  // ---- hook-type gate inputs (computed, not claimed) ----
  const hookWords = plan.keptWords.filter((w) => w.end <= CONFIG.HOOK_WINDOW);
  const hookProbe = hookWords.length > 0 ? hookWords : clipWords.slice(0, 8);
  const hookText = hookProbe.map((w) => w.word).join(" ");
  const hookWindowStart = Math.min(clipWords[0]?.start ?? 0, hookProbe[0]?.start ?? 0);
  const hookSentences = clipSentences.filter((s) => plan.toOutput(Math.max(s.start, hookWindowStart)) < CONFIG.HOOK_WINDOW + 0.5);
  const hookSentenceText = (hookSentences.length ? hookSentences : [clipSentences[0]]).map((s) => s.text).join(" ");
  const earlyWords = (() => {
    const ew = plan.keptWords.filter((w) => w.end <= CONFIG.HOOK_EARLY_SEC);
    return ew.length >= 3 ? ew : plan.keptWords.slice(0, Math.min(4, plan.keptWords.length));
  })();
  const earlySentenceText = (() => {
    const es = clipSentences.filter((s) => plan.toOutput(Math.max(s.start, hookWindowStart)) < CONFIG.HOOK_EARLY_SEC + 0.25);
    return (es.length ? es : [clipSentences[0]]).map((s) => s.text).join(" ");
  })();
  const earlyText = earlyWords.map((w) => w.word).join(" ");

  const hookLoop = detectOpenLoop({ sentencesText: hookSentenceText, wordsText: hookText, firstWord: clipWords[0]?.word });
  const earlyLoop = detectOpenLoop({ sentencesText: earlySentenceText, wordsText: earlyText, firstWord: clipWords[0]?.word });
  const hookCare = detectCareSignal(hookProbe);
  const earlyCare = detectCareSignal(earlyWords);
  const hookType = HOOK_TYPES.has(raw.hook_type) ? raw.hook_type : "none";
  // A classified hook type is a care CLAIM (a confession implies stakes, a
  // shocking fact implies recognition) — honored like v2.3 honored
  // reason_to_care: counts unless the opening is an announcer open.
  const hookCareClaimed = hookType !== "none" && !hookLoop.flat;
  const noCare = !hookCare.found && !hookCareClaimed;
  // A "none" hook type plus no structural loop = the opening is not a hook,
  // whatever the judge scored (the judge grades itself; code holds the bar).
  const hookOpenQuestion = hookLoop.found || (hookType !== "none" && !hookLoop.flat);
  const questionClaimUnverified = hookType !== "none" && !hookLoop.found && !hookLoop.flat;
  const flatOpen = hookLoop.flat && !hookLoop.found;
  const deadHook = !hookOpenQuestion && noCare;
  const lateSignal = !(earlyLoop.found || earlyCare.found) && (hookLoop.found || hookCare.found);
  const hedgedOpen = HEDGE_RE.test(earlyText);
  const hookConcrete = detectConcreteDetail(hookProbe);
  const concreteOverclaimed = !hookConcrete.found && VAGUE_RE.test(hookText);

  // ---- hook caps (code applies; the model never sets the bar) ----
  if (payoffInWindow) cap("hook", 3, "payoff in hook window");
  if (fillerOpen) cap("hook", 4, greeting ? "greeting open" : "filler open");
  if (flatOpen) cap("hook", 5, "announcer open — the clip announces itself instead of creating a question");
  if (hookType === "none" && !hookOpenQuestion) cap("hook", 5, "no hook structure in the opening");
  if (concreteOverclaimed) cap("hook", 7, "concrete detail claimed but the hook words are vague");
  if (hedgedOpen) cap("hook", 6, "hedged open — 'I think / maybe' in the first seconds reads as low confidence");
  if (noCare) cap("hook", CONFIG.HOOK_CARE_CAP, "no reason to care in the hook window");
  if (!hookOpenQuestion && noCare) cap("hook", CONFIG.HOOK_DEAD_CAP, "no open question and no reason to care in the hook window");
  if (lateSignal) cap("hook", CONFIG.HOOK_LATE_SIGNAL_CAP, `open loop or reason to care only after the first ${CONFIG.HOOK_EARLY_SEC} seconds`);

  // ---- [A] emotional build + release: a peak with no buildup feels random ----
  const primaryEmotion = EMOTION_TYPES.has(raw.primary_emotion) ? raw.primary_emotion : "none";
  const emotionIntensity = Math.round(clampNum(raw.emotion_intensity, 0, 10));
  const peakWithoutBuildup = primaryEmotion !== "none" && payoffOut < CONFIG.EMOTION_BUILDUP_MIN_SEC;
  if (peakWithoutBuildup) cap("emotion", CONFIG.PEAK_NO_BUILDUP_CAP, `peak lands ${round2(payoffOut)}s in — no buildup before it`);

  // ---- penalties ----
  const penalties = {};
  const penaltyWhy = {};
  const penalize = (key, why) => { penalties[key] = PENALTY_VALUES[key]; penaltyWhy[key] = why; };
  if (payoffPct < CONFIG.PAYOFF_MIN_POSITION) penalize("payoff_too_early", `payoff at ${Math.round(payoffPct * 100)}% of clip`);
  if (fillerDensity > CONFIG.FILLER_MAX) penalize("dead_air", `${fillerDensity.toFixed(1)} filler per 100 words after edit`);
  else if (maxGap > CONFIG.GAP_HARD) penalize("dead_air", `${maxGap.toFixed(2)} s internal gap after edit`);
  if (needsContext) penalize("needs_outside_context", raw.needs_context === true ? "judge flagged context dependence" : `unresolved reference "${String(dangling).slice(0, 40)}"`);
  const leak = payoffLeakRatio(title, payoffText);
  if (leak > 0.5) penalize("hook_content_mismatch", `title leaks payoff (${Math.round(leak * 100)}% overlap)`);
  if (ctx.hasProfile && raw.off_audience === true) penalize("off_audience", "model flag");
  if (raw.no_clean_ending === true) penalize("no_clean_ending", "model flag");
  else if (codeNoCleanEnding) penalize("no_clean_ending", "last word does not end a sentence");

  // Repetition + wind-down ("nothing in the way")
  const repRatio = plan.keptWords.length >= CONFIG.REPETITION_MIN_WORDS ? repeatedPhraseRatio(plan.keptWords) : 0;
  if (repRatio > CONFIG.REPETITION_MAX_RATIO) penalize("repeats_itself", `${Math.round(repRatio * 100)}% repeated phrases after edit`);
  const tailSentences = Math.max(0, s1.idx - payoff.idx);
  const tailSec = tailSentences > 0 ? Math.max(0, plan.toOutput(s1.end) - plan.toOutput(payoff.end)) : 0;
  const windDown = tailSentences > CONFIG.WIND_DOWN_MAX_SENTS || tailSec > CONFIG.WIND_DOWN_MAX_SEC;
  if (windDown) penalize("wind_down_tail", `${tailSentences} sentence(s), ${round2(tailSec)} s after the payoff`);
  if (!hookOpenQuestion && noCare) penalize("no_reason_to_care", "hook window has no open question and no reason-to-care signal");

  // ---- the hook earns the clip — the gate ----
  // Strict mode: a dead hook or a final (capped) hook under HOOK_MIN_STRENGTH
  // hard-rejects. The orchestrator's rescue pass runs BEFORE giving up.
  if (ctx.strict) {
    if (CONFIG.HOOK_DEAD_REJECT && deadHook) hardFails.push("dead_hook");
    if (scores.hook < CONFIG.HOOK_MIN_STRENGTH) hardFails.push("weak_hook");
  }

  // ---- total (fixed [A] weights — code computes, the model never does) ----
  const base =
    WEIGHTS.hook * scores.hook +
    WEIGHTS.emotion * scores.emotion +
    WEIGHTS.clarity * scores.clarity +
    WEIGHTS.payoff * scores.payoff +
    WEIGHTS.share * scores.share;
  const penaltySum = Object.values(penalties).reduce((a, b) => a + b, 0);
  const matchedPatterns = [...new Set((Array.isArray(raw.matched_patterns) ? raw.matched_patterns : []).map(String))]
    .filter((id) => ctx.patternIds.has(id));
  const bonus = Math.min(CONFIG.PATTERN_BONUS_CAP, CONFIG.PATTERN_BONUS * matchedPatterns.length);
  // Creator style preferences: a small, capped nudge toward the requested
  // moment styles — the prompts carry the intent, this only breaks ranking
  // ties toward what the user actually asked for.
  const clipTypeEarly = CLIP_TYPES.has(raw.type) ? raw.type : "story";
  const styleMatched = (Array.isArray(ctx.stylePrefs) && ctx.stylePrefs.length)
    ? ctx.stylePrefs.filter((k) => {
        const def = MOMENT_STYLES[k];
        if (!def) return false;
        return def.types.includes(clipTypeEarly) ||
          (primaryEmotion !== "none" && def.emotions.includes(primaryEmotion));
      })
    : [];
  const styleBonus = Math.min(CONFIG.STYLE_BONUS_CAP, CONFIG.STYLE_BONUS * styleMatched.length);
  const total = round2(clampNum(base - penaltySum + bonus + styleBonus, 0, 10));

  if (ctx.strict && hardFails.length) {
    const note = worstTitleProblems.length ? `title names facts not in transcript: ${worstTitleProblems.join(", ")}` : hardFails.join(", ");
    return reject(hardFails, note);
  }

  const clipType = CLIP_TYPES.has(raw.type) ? raw.type : "story";
  const strongest = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const spokenHook = spoken.slice(0, 300);

  // What the ending makes them do — text proxies keyed on the [A] clip types.
  const backText = plan.keptWords.slice(Math.floor(plan.keptWords.length / 2)).map((w) => w.word).join(" ");
  const clipWordsText = clipWords.map((w) => w.word).join(" ");
  const predictedActions = {
    rewatch: (clipType === "story" || clipType === "insight") && !windDown && payoffPct >= 0.7,
    share: FEELING_RE.test(backText) || STAKES_RE.test(backText) || clipType === "emotional" || clipType === "humor",
    save: USEFUL_RE.test(clipWordsText) || clipType === "how_to" || clipType === "insight" || scores.clarity >= 8,
    comment: ARGUE_RE.test(clipWordsText) || clipType === "hot_take" || clipType === "controversy",
    follow: Boolean(hookCare.person) && SELF_INTRO_RE.test(normalize(clipWordsText)),
  };
  const sendTo = predictedActions.share ? "share"
    : predictedActions.save ? "save"
    : predictedActions.comment ? "comment"
    : predictedActions.follow ? "follow"
    : predictedActions.rewatch ? "rewatch"
    : null;

  // The 30-second gut check, computed where text allows.
  const gutCheck = {
    sound_off_first_frame: null, // invisible to transcript scoring — the edit owns face, energy, motion
    question_after_first_sentence: openQuestionSignal(clipSentences[0].text),
    who_talking_clear: Boolean(clipSentences[0].speaker) || Boolean(hookCare.person) || SELF_INTRO_RE.test(normalize(clipWordsText)),
    boring_second: maxGap > CONFIG.GAP_HARD || repRatio > CONFIG.REPETITION_MAX_RATIO,
    ending_delivers: payoffPct >= CONFIG.PAYOFF_MIN_POSITION && !windDown,
    loops_to_start: contentWords(s1.text).some((w) => contentWords(clipSentences[0].text).includes(w)),
    send_to: sendTo,
  };

  // On-screen hook captions, validated: 3-7 words, max 3, non-empty.
  const hookCaptions = (Array.isArray(raw.hook_captions) ? raw.hook_captions : [])
    .map((c) => String(c ?? "").replace(/\s+/g, " ").trim())
    .filter((c) => {
      const n = c.split(" ").filter(Boolean).length;
      return n >= CONFIG.HOOK_CAPTION_MIN_WORDS && n <= CONFIG.HOOK_CAPTION_MAX_WORDS;
    })
    .slice(0, 3);

  const sceneSkips = sceneSkipList(plan);

  return {
    ok: true,
    clip: {
      start,
      end,
      start_id: s0.id,
      end_id: s1.id,
      clip_type: clipType,
      title: title.slice(0, 120),
      hook: spokenHook,
      total,
      reason: String(raw.reason ?? "").slice(0, 500) || `${clipType}: strongest dimension ${strongest}.`,
      hashtags: sanitizeHashtags(raw.hashtags),
      segments: plan.segments,
      output_duration: duration,
      edited_words: plan.keptWords,
      hard_fails: hardFails, // non-empty only in score/report mode
      intel_json: {
        version: "v3.0",
        start_id: s0.id,
        end_id: s1.id,
        payoff_id: payoff.id,
        clip_type: clipType,
        hook_type: hookType,
        title,
        titles_proposed: (Array.isArray(raw.titles) ? raw.titles : []).slice(0, 5),
        hook_captions: hookCaptions,
        hook: spokenHook,
        summary: String(raw.summary ?? "").slice(0, 300),
        open_questions: [],
        window_hash: hashText(clipSentences.map((s) => formatLine(s)).join("\n")),
        judge: {
          reasoning: String(raw.judge_reasoning ?? "").slice(0, 500),
          scores: judgeScores,
          scores_after_caps: scores,
          caps_applied: capsApplied,
          primary_emotion: primaryEmotion,
          emotion_intensity: emotionIntensity,
          peak_without_buildup: peakWithoutBuildup,
          needs_context: raw.needs_context === true,
          same_idea: raw.same_idea ?? null,
          unfixable_claim: raw.unfixable === true,
        },
        model_scores: judgeScores,
        scores,
        caps_applied: capsApplied,
        penalties,
        penalty_reasons: penaltyWhy,
        base: round2(base),
        pattern_bonus: bonus,
        style: {
          requested: Array.isArray(ctx.stylePrefs) ? ctx.stylePrefs : [],
          matched: styleMatched,
          bonus: round2(styleBonus),
        },
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
          title_leak_ratio: round2(leak),
          leading_words_trimmed: lead,
          model_hook_type: hookType,
          context: { dangling_reference: dangling ?? null, resolved_by: resolvedBy },
        },
        retention: {
          hook_open_question: hookOpenQuestion,
          hook_open_loop: {
            found: hookLoop.found,
            kinds: hookLoop.kinds,
            claim_unverified: questionClaimUnverified,
            flat_open: flatOpen,
          },
          hook_reason_to_care: { found: hookCare.found, kinds: hookCare.kinds, person: hookCare.person },
          hook_early_window: {
            sec: CONFIG.HOOK_EARLY_SEC,
            loop: earlyLoop.found,
            care: earlyCare.found,
            late_signal: lateSignal,
            hedged_open: hedgedOpen,
          },
          hook_concrete: { found: hookConcrete.found, markers: hookConcrete.markers, overclaimed: concreteOverclaimed },
          hook_words: hookText.slice(0, 160),
          hook_probe_words: hookProbe.length,
          repeated_phrase_ratio: round2(repRatio),
          wind_down: { sentences: tailSentences, sec: round2(tailSec), penalized: windDown },
          title_specific: /\d/.test(title) || Boolean(namedPersonInWords(title.split(/\s+/).map((w) => ({ word: w })))),
          predicted_actions: predictedActions,
          gut_check: gutCheck,
          first_frame_note: "transcript scoring cannot see the first frame (face, energy, motion) — confirm in the edit",
        },
        hard_fails: hardFails,
        flags,
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
          hook_min_strength: CONFIG.HOOK_MIN_STRENGTH,
          payoff_min_position: CONFIG.PAYOFF_MIN_POSITION,
          bounds: ctx.bounds,
        },
      },
    },
  };
}

// =====================================================================
// The hook gate — a separate stage [A]
// "Hook gate: a separate AI check scores only the first 3 seconds. Below the
//  threshold, the clip is either rescued by trimming or cold-opening, or
//  dropped. The hook gate is a hard filter."
//
// Two steps, batched so the gate costs ONE model call per video:
//   1. CODE pre-screen: an opening under the rescue bar (or a hook-related
//      rejection) is fixed by restarting the clip on the strongest computed
//      line ("start the clip right on it" — no video reordering, so captions
//      and the renderer's ordered-concat contract stay valid). A structural
//      probe with a code hook estimate filters attempts that cannot pass
//      (duration, housekeeping, ...).
//   2. AI GATE: the NEW first ~8 words go to the dedicated gate check, which
//      scores them 1-10 as a scrolling viewer would. The final evaluation
//      re-runs with the gate's score; verdicts under HOOK_MIN_STRENGTH drop.
//      A gate-call failure degrades to the code estimate (logged) — a gate
//      infrastructure error must not mass-drop clips.
// =====================================================================

const HOOK_GATE_SYSTEM_PROMPT = `You are judging ONLY the first 3 seconds (about the first 8 words) of each clip, as a scrolling viewer would. Answer: does the opening make me stop scrolling?

Score 1-10 on: instant curiosity or feeling, clarity with no context, and zero filler. A greeting, "so", "um", "basically", "today I want to talk about", or any lead-in setup is a 1-3. A bold claim, a question the viewer needs answered, a confession, a shocking fact, or a mid-action start with stakes visible is a 7-9.

Classify the hook type: bold_claim | curiosity_gap | direct_question | conflict_confession | shocking_fact | mid_action | none.

If the score is below 6 the verdict is "unfixable"; otherwise "fixed". Never invent words that were not spoken.

Return ONLY this JSON:
{"judgments": [{"id": "<the id you were given>", "hook_score": 0, "hook_type": "bold_claim", "verdict": "fixed", "why": "one line"}]}`;

function parseGateResponse(content) {
  const cleaned = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const objStart = cleaned.indexOf("{");
  if (objStart === -1) throw new Error("hook gate response contained no JSON");
  const parsed = JSON.parse(cleaned.slice(objStart, cleaned.lastIndexOf("}") + 1));
  const list = Array.isArray(parsed?.judgments) ? parsed.judgments : [];
  const out = new Map();
  for (const j of list) {
    const id = String(j?.id ?? "").trim();
    if (!id || out.has(id)) continue;
    const score = Math.round(Number(j?.hook_score));
    out.set(id, {
      id,
      hook_score: Number.isFinite(score) ? Math.min(10, Math.max(0, score)) : null,
      hook_type: HOOK_TYPES.has(String(j?.hook_type)) ? String(j.hook_type) : "none",
      verdict: String(j?.verdict) === "unfixable" ? "unfixable" : "fixed",
      why: String(j?.why ?? "").slice(0, 200),
    });
  }
  return out;
}

/**
 * Code hook estimate for a RESCUED opening — the same lexicons the caps use,
 * so the structural probe and the gate-error fallback judge the new opening
 * with the same bar the final evaluation enforces.
 */
function codeHookEstimate(raw2, ctx) {
  const s0 = ctx.byNum.get(parseId(raw2.start_id));
  if (!s0) return 4;
  const text = s0.text;
  const wordObjs = text.split(/\s+/).filter(Boolean).map((w) => ({ word: w }));
  const loop = detectOpenLoop({ sentencesText: text, wordsText: text, firstWord: text.split(/\s+/)[0] });
  const care = detectCareSignal(wordObjs);
  let sc = 5;
  if (loop.found) sc += 1;
  if (care.found) sc += 1;
  if (detectConcreteDetail(wordObjs).found) sc += 1;
  if (loop.flat && !loop.found) sc = 4;
  return Math.min(8, sc);
}

/**
 * Find a rescue start for one candidate: the strongest computed hook line
 * strictly after the current start and before the payoff, tried strongest
 * first. Returns the MODIFIED raw (not a final clip) — the AI gate scores
 * the new opening before anything is adopted.
 */
function hookGateRescue(raw, ctx, { rejectionReasons = null, currentHook = null } = {}) {
  const attempts = { tried: [], adoptedRaw: null, flag: null };
  const needsRescue =
    (rejectionReasons && rejectionReasons.every((r) => r === "weak_hook" || r === "dead_hook" || r === "housekeeping_open")) ||
    (currentHook != null && currentHook < CONFIG.HOOK_GATE_RESCUE_BELOW);
  if (!needsRescue) return attempts;

  const s0 = ctx.byNum.get(parseId(raw.start_id));
  const s1 = ctx.byNum.get(parseId(raw.end_id));
  const payoff = ctx.byNum.get(parseId(raw.payoff_id)) ?? s1;
  if (!s0 || !s1) return attempts;

  const hints = hookHints(ctx.sentences)
    .filter((h) => h.idx > s0.idx && h.idx < payoff.idx)
    .slice(0, CONFIG.HOOK_RESCUE_MAX_TRIES);
  if (hints.length === 0) return attempts;

  const laterHalf = s0.idx + Math.floor((s1.idx - s0.idx) / 2);
  for (const hint of hints) {
    const line = ctx.sentences[hint.idx];
    const raw2 = {
      ...raw,
      start_id: line.id,
      scenes: [{ start_id: line.id, end_id: raw.end_id }],
    };
    attempts.tried.push(line.id);
    // Structural probe with the code estimate — the real hook score comes
    // from the batched AI gate; this pass only filters attempts that cannot
    // structurally pass (duration, housekeeping, empty after trim, ...).
    let probe;
    try {
      probe = evaluateCandidate({ ...raw2, scores: { ...raw.scores, hook: codeHookEstimate(raw2, ctx) } }, ctx);
    } catch {
      continue;
    }
    if (probe.ok && probe.clip.intel_json.scores.hook >= CONFIG.HOOK_MIN_STRENGTH) {
      // A restart deep into the clip is a cold open; a small start shift is
      // a rescue. Same mechanism, different label for the tuning log.
      attempts.adoptedRaw = raw2;
      attempts.flag = hint.idx >= laterHalf ? "cold_open" : "hook_rescued_start";
      return attempts;
    }
  }
  return attempts;
}

// =====================================================================
// Best-moment scouting — kept from v2.4 (user-facing feature)
// =====================================================================

/**
 * Rank sentences by "moment" value — the lines anywhere in the video that
 * could strengthen a clip: reveals, numbers, emotional peaks, strong takes.
 */
function momentHints(sentences, exclude, max = CONFIG.SCOUT_BOARD_MAX, styles = []) {
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
    // Style-matched moments get a small board boost so style-driven scouting
    // surfaces them first (the model still decides what merges coherently).
    const styleTags = [];
    if (Array.isArray(styles) && styles.length) {
      if (styles.includes("funny") && LAUGHTER_RE.test(text)) styleTags.push("funny");
      if ((styles.includes("controversial") || styles.includes("dramatic")) && ARGUE_RE.test(text)) styleTags.push("controversial");
      if (styles.includes("hype") && HYPE_RE.test(text)) styleTags.push("hype");
      if ((styles.includes("wholesome") || styles.includes("inspiring")) && (FEELING_RE.test(text) || USEFUL_RE.test(text))) styleTags.push("uplifting");
      if ((styles.includes("sad") || styles.includes("dramatic")) && (FEELING_RE.test(text) || TRAIL_OFF_RE.test(text))) styleTags.push("emotional");
      if (styleTags.length) sc += 1.5;
    }
    if (sc >= 2) scored.push({ t: s.start, id: s.id, sc, signals: styleTags.length ? [...signals, ...styleTags] : signals });
  }
  return scored.sort((a, b) => b.sc - a.sc).slice(0, max);
}

function buildScoutRequest({ clip, sentences, board, headroomSec, creatorProfile, patterns, styles = [] }) {
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
      title: clip.title,
      spoken_hook: clip.hook,
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
  if (Array.isArray(styles) && styles.length) {
    req.style_preferences = {
      note: "the creator asked for these moment styles — prefer board entries and merges that deliver them",
      styles: styles.map((k) => MOMENT_STYLES[k]?.label ?? k),
    };
  }
  req.scout_board = board;
  return JSON.stringify(req, null, 2);
}

const SCOUT_SYSTEM_PROMPT = `You are a short-form editor composing one clip out of the best moments of a long video. You receive the clip (title, spoken hook, scenes, kept text with sentence IDs, duration), a scout_board: code-ranked moments from the REST of the video — including strong moments that did not survive as standalone clips, which are ideal merge material — and headroom_sec: how much speaking time the merged clip may still gain.

Your job: scout MULTIPLE moments from anywhere on the board and merge them with the clip's existing scenes so the result is ONE clip built from the best moments with nothing boring in between. Think montage: a stronger opening, the missing payoff, proof or escalation, a reaction beat — every scene must earn its place.
- Return ONLY this JSON: {"add_scenes": [{"start_id": "S12", "end_id": "S14", "why": "one sentence"}], "scout_notes": "optional one-liner"}. An empty add_scenes is a valid answer when the clip is already the best version of itself — never add a shot just to fill headroom.
- Merge, in order of value: 1) a stronger opening — a line that creates the question faster or harder than the clip's current first scene. 2) the missing payoff — the moment elsewhere that actually delivers what the hook promises; it must land as the last scene. 3) proof or escalation — a number, demo, reaction or concrete detail that makes the story hit harder. 4) a contrast or reaction beat that keeps the middle alive.
- Every scene must survive without the material between the scenes: no dangling reference, no pronoun whose subject is skipped, no mid-story fragment whose setup stays behind. Say in "why" how the scene connects.
- Scenes stay in original transcript order, never overlap, and never start after the payoff. Each scouted scene spans 2-30 s of speaking time and the total added time stays within headroom_sec.
- The merged clip must still be one coherent thought with the hook first and the payoff last. If nothing on the board truly helps, return no scenes.
- If a board entry delivers what the hook promises better than the clip's current payoff does, crown it: return its sentence as payoff_id. The merged clip must then end on that payoff.
- style_preferences (when present): the creator asked for these moment styles — prefer board entries that match them, as long as the merge stays coherent.`;

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
 * Scout one picked clip — the multi-moment composer. The model may propose up
 * to MAX_SCENES-1 additional moments from anywhere in the video (they become
 * extra scenes); code validates them, merges the scene list, re-runs the FULL
 * gate on the merged edit and keeps the merge only when the clip still passes
 * and does not score worse than the original. Never throws — a scout failure
 * returns the original clip.
 */
async function scoutClip(clip, { sentences, shared, creatorProfile, patterns, diagnostics, extraMoments = [] }) {
  const setScout = (meta) => {
    clip.intel_json = { ...(clip.intel_json ?? {}), scout: { attempted: true, ...meta } };
    return clip;
  };

  try {
    const ij = clip.intel_json ?? {};
    const curScenes = Array.isArray(ij.scenes) && ij.scenes.length >= 2
      ? ij.scenes.map((s) => ({ start_id: String(s.start_id), end_id: String(s.end_id) }))
      : [{ start_id: clip.start_id, end_id: clip.end_id }];
    const firstSent = sentences[parseId(curScenes[0].start_id) - 1];
    const lastSent = sentences[parseId(curScenes[curScenes.length - 1].end_id) - 1];
    if (!firstSent || !lastSent) return setScout({ accepted: false, why: "clip sentence IDs unresolved" });

    const bounds = shared.bounds;
    const ceiling = bounds.max + CONFIG.DURATION_SLACK;
    const headroom = Math.max(0, ceiling - clip.output_duration);
    const budget = Math.min(CONFIG.SCOUT_MAX_ADDED_SEC, headroom);
    if (budget < CONFIG.SCOUT_MIN_LEN) {
      return setScout({ accepted: false, why: "no headroom left for a scouted shot", board_size: 0 });
    }
    // Board = code-ranked moments from the rest of the video, plus the strong
    // candidates that did not ship standalone (prime merge material) — style
    // boosts apply so style-driven scouting sees matching moments first.
    const hints = momentHints(sentences, { from: firstSent.idx, to: lastSent.idx }, CONFIG.SCOUT_BOARD_MAX, shared.stylePrefs);
    const extra = (Array.isArray(extraMoments) ? extraMoments : []).filter(
      (m) => m && !(m.t >= firstSent.start && m.t <= lastSent.end)
    );
    const board = [...extra, ...hints].slice(0, CONFIG.SCOUT_BOARD_MAX);

    const userPrompt = buildScoutRequest({ clip, sentences, board, headroomSec: headroom, creatorProfile, patterns, styles: shared.stylePrefs });
    let parsed;
    try {
      const content = await chatComplete(SCOUT_SYSTEM_PROMPT, userPrompt, {
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        temperature: CONFIG.MODEL_TEMPERATURE,
      });
      parsed = parseScoutResponse(content);
    } catch (err) {
      diagnostics.scoutErrors.push({ clip: clip.start_id, error: String(err?.message ?? err) });
      return setScout({ accepted: false, why: "scout pass failed", board_size: board.length });
    }

    const slots = Math.max(0, CONFIG.MAX_SCENES - curScenes.length);
    const payoffSent = ij.payoff_id ? sentences[parseId(ij.payoff_id) - 1] : null;
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

    const allScenes = [
      ...curScenes.map((sc) => ({ start_id: sc.start_id, end_id: sc.end_id, num: parseId(sc.start_id) })),
      ...accepted.map((x) => ({ start_id: x.a.id, end_id: x.b.id, num: x.a.num })),
    ].sort((x, y) => x.num - y.num);
    const mergedScenes = allScenes.map(({ start_id, end_id }) => ({ start_id, end_id }));

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
    // Rebuild the candidate in v3.0 shape from the stored intel_json so every
    // check and score runs again on the merged edit with the same judgment.
    const penaltyFlags = {};
    for (const [k, v] of Object.entries(ij.penalty_reasons ?? {})) {
      if (v === "model flag") penaltyFlags[k === "no_clean_ending" ? "no_clean_ending" : k] = true;
    }
    const raw2 = {
      start_id: curScenes[0].start_id,
      end_id: curScenes[curScenes.length - 1].end_id,
      payoff_id: payoffId,
      scenes: mergedScenes,
      type: ij.clip_type,
      hook: { spoken_text: ij.hook },
      summary: ij.summary ?? ij.title,
      titles: [ij.title, ...(Array.isArray(ij.titles_proposed) ? ij.titles_proposed : [])].filter(Boolean),
      hook_captions: Array.isArray(ij.hook_captions) ? ij.hook_captions : [],
      scores: ij.judge?.scores ?? ij.model_scores,
      hook_type: ij.hook_type,
      primary_emotion: ij.judge?.primary_emotion ?? "none",
      emotion_intensity: ij.judge?.emotion_intensity ?? 0,
      no_clean_ending: penaltyFlags.no_clean_ending === true,
      off_audience: penaltyFlags.off_audience === true,
      context: ij.checks?.context ?? { dangling_reference: null, resolved_by: "clip" },
      reason: clip.reason,
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
// Ranking
// =====================================================================

function dedupeClips(sorted) {
  // Overlap measured on KEPT material (segments when present), so a
  // scene-stitched clip does not shadow unrelated clips that live inside its
  // skipped middle.
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

/** [A] same-idea duplicates: the judge labels them; code keeps the best. */
function dedupeSameIdea(sorted) {
  const seen = new Map(); // label -> best clip
  const kept = [];
  for (const clip of sorted) {
    const label = clip.intel_json?.judge?.same_idea;
    if (!label) { kept.push(clip); continue; }
    const existing = seen.get(label);
    if (!existing || clip.total > existing.total) {
      if (existing) kept.splice(kept.indexOf(existing), 1);
      seen.set(label, clip);
      kept.push(clip);
    } else {
      // worse duplicate — dropped silently, the label logs the reason
    }
  }
  return kept;
}

/** [mine] at most 2 of one clip type in the top 5, unless the alternative is > 1.0 lower. */
function pickWithTypeCap(ranked, target) {
  const cfg = CONFIG.ARCHETYPE_CAP;
  if (!cfg) return ranked.slice(0, target);
  const pool = [...ranked];
  const out = [];
  const counts = new Map();
  while (out.length < target && pool.length) {
    let i = 0;
    const top = pool[0];
    if (out.length < cfg.topN && (counts.get(top.clip_type) ?? 0) >= cfg.max) {
      const alt = pool.findIndex((c) => (counts.get(c.clip_type) ?? 0) < cfg.max);
      if (alt !== -1 && top.total - pool[alt].total <= cfg.margin) i = alt;
    }
    const [pick] = pool.splice(i, 1);
    out.push(pick);
    counts.set(pick.clip_type, (counts.get(pick.clip_type) ?? 0) + 1);
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

function prepare({ transcriptJson, clipLengthPref, creatorProfile, engagementPatterns, stylePrefs }) {
  const { sentences, words, punctuated } = segmentSentences(transcriptJson?.words ?? []);
  if (sentences.length === 0) throw new Error("no transcript words to analyze");
  const patterns = (Array.isArray(engagementPatterns) ? engagementPatterns : []).filter((p) => p?.id);
  const styles = normalizeStylePrefs(stylePrefs);
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
      stylePrefs: styles,
      styleSets: {
        types: new Set(styles.flatMap((k) => MOMENT_STYLES[k].types)),
        emotions: new Set(styles.flatMap((k) => MOMENT_STYLES[k].emotions)),
      },
    },
    patterns,
  };
}

// =====================================================================
// Public API
// =====================================================================

/**
 * v3.0 select: finder → judge → refine → hook gate → rank → scout → package.
 * Returns the shape analyze.js expects plus intel_json, segments (the
 * dead-air/scene edit list) and edited_words (captions).
 */
export async function detectViralClips({
  transcriptJson,
  durationSeconds,
  maxClips,
  clipLengthPref = "ai_optimized",
  creatorProfile = null,
  engagementPatterns = [],
  audioSignals = null,
  onDiagnostics = null,
  stylePrefs = [],
}) {
  const { sentences, words, shared, patterns } = prepare({ transcriptJson, clipLengthPref, creatorProfile, engagementPatterns, stylePrefs });
  const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : words[words.length - 1].end;
  const target = Math.max(1, Math.floor(Number(maxClips) || 5));

  const tagMap = computeEmotionTags(sentences, audioSignals);
  const genre = detectGenre(sentences);

  const styleNoteText = styleNote(shared.stylePrefs);
  const finderPrompt = FINDER_SYSTEM_PROMPT
    .replaceAll("{{MIN_DURATION}}", String(shared.bounds.min))
    .replaceAll("{{MAX_DURATION}}", String(shared.bounds.max))
    .replaceAll("{{FINDER_MIN}}", String(CONFIG.FINDER_MIN_PER_CHUNK))
    .replaceAll("{{FINDER_MAX}}", String(CONFIG.FINDER_MAX_PER_CHUNK))
    .replaceAll("{{STYLE_NOTE}}", styleNoteText);
  const judgePrompt = JUDGE_SYSTEM_PROMPT
    .replaceAll("{{GENRE_NOTE}}", GENRE_NOTES[genre.genre] ?? GENRE_NOTES.generic)
    .replaceAll("{{STYLE_NOTE}}", styleNoteText);

  const chunks = chunkSentences(sentences, duration);
  const diagnostics = {
    version: "v3.0",
    genre: genre.genre,
    genre_markers: genre.markers,
    finderDropped: [],
    finderErrors: [],
    candidatesFound: 0,
    judgeErrors: [],
    unjudged: [],
    codeRejected: [],
    hookGate: { rescued: [], coldOpens: [], unfixable: [] },
    belowThreshold: [],
    sameIdeaDropped: 0,
    skipped: [],
    scoutErrors: [],
  };

  // ---- STAGE 1: finder (per window, recall favored) ----
  const perChunk = await mapLimit(chunks, CONFIG.CHUNK_CONCURRENCY, async (chunk) => {
    const chunkMeta = chunks.length > 1
      ? { window: { from_sec: Math.round(chunk.from), to_sec: Math.round(chunk.to), video_duration_sec: Math.round(duration), note: "Sentence IDs and timestamps are absolute across the full video." } }
      : { window: { video_duration_sec: Math.round(duration) } };
    try {
      const userPrompt = buildFinderRequest({ sentences: chunk.sentences, tagMap, bounds: shared.bounds, chunkMeta });
      const content = await chatComplete(finderPrompt, userPrompt, {
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        temperature: CONFIG.MODEL_TEMPERATURE,
      });
      const { candidates, dropped, totalProposed } = parseFinderResponse(content, chunk.sentences);
      diagnostics.finderDropped.push(...dropped);
      return candidates.map((c) => ({ ...c, chunk }));
    } catch (err) {
      diagnostics.finderErrors.push({ window: chunkMeta.window, error: String(err?.message ?? err) });
      return [];
    }
  });

  if (diagnostics.finderErrors.length === chunks.length) {
    throw new Error(`clip intelligence failed on every window: ${diagnostics.finderErrors[0].error}`);
  }

  const candidates = perChunk.flat();
  candidates.forEach((c, i) => { c.id = `C${i + 1}`; });
  diagnostics.candidatesFound = candidates.length;

  // ---- STAGE 2: judge (all candidates together, harsh rubric) ----
  const judgedById = new Map();
  for (let i = 0; i < candidates.length; i += CONFIG.JUDGE_BATCH_MAX) {
    const batch = candidates.slice(i, i + CONFIG.JUDGE_BATCH_MAX);
    try {
      const userPrompt = buildJudgeRequest({ candidates: batch, sentences, tagMap, genre, creatorProfile, patterns, styles: shared.stylePrefs });
      const content = await chatComplete(judgePrompt, userPrompt, {
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        temperature: CONFIG.MODEL_TEMPERATURE,
      });
      for (const [id, judged] of parseJudgeResponse(content)) judgedById.set(id, judged);
    } catch (err) {
      diagnostics.judgeErrors.push({ batch: i, error: String(err?.message ?? err) });
    }
  }

  // ---- REFINE + HOOK GATE (code pre-screen) ----
  const passing = [];
  const gateJobs = [];
  for (const c of candidates) {
    const judged = judgedById.get(c.id);
    if (!judged) {
      diagnostics.unjudged.push({ id: c.id, span: `${c.s0.id}-${c.s1.id}`, reason: "no judge result" });
      continue;
    }
    if (judged.unjudged) {
      diagnostics.unjudged.push({ id: c.id, span: `${c.s0.id}-${c.s1.id}`, reason: judged.reason });
      continue;
    }
    const ctx = makeWindowContext(c.chunk.sentences, shared, { strict: true, enforceDuration: true });
    const raw = {
      start_id: c.s0.id,
      end_id: c.s1.id,
      scenes: null,
      payoff_id: judged.payoff_id,
      type: c.type,
      hook: { spoken_text: c.hook },
      summary: c.summary,
      titles: judged.titles,
      hook_captions: judged.hook_captions,
      scores: judged.scores,
      hook_type: judged.hook_type,
      primary_emotion: judged.primary_emotion,
      emotion_intensity: judged.emotion_intensity,
      needs_context: judged.needs_context,
      same_idea: judged.same_idea,
      unfixable: judged.unfixable,
      judge_reasoning: judged.reasoning,
      reason: [c.why, judged.reasoning].filter(Boolean).join(" — "),
      hashtags: c.hashtags,
    };
    let res;
    try {
      res = evaluateCandidate(raw, ctx);
    } catch (err) {
      diagnostics.codeRejected.push({ start_id: c.s0.id, end_id: c.s1.id, reasons: ["eval_error"], note: String(err?.message ?? err), source: "code" });
      continue;
    }

    if (res.ok) {
      const hook = res.clip.intel_json.scores.hook;
      if (hook < CONFIG.HOOK_GATE_RESCUE_BELOW) {
        // Publishable but under the rescue bar — find a stronger opening; the
        // batched AI gate scores it before anything is adopted.
        const rescue = hookGateRescue(raw, ctx, { currentHook: hook });
        if (rescue.adoptedRaw) {
          gateJobs.push({ id: c.id, raw: rescue.adoptedRaw, ctx, flag: rescue.flag, original: res.clip, kind: "improve", tried: rescue.tried });
        } else {
          passing.push(res.clip);
        }
      } else {
        passing.push(res.clip);
      }
      continue;
    }

    // Rejected — the gate gives hook-related failures a rescue pass before
    // the clip is dropped ("fixed or rejected, not published").
    const reasons = res.rejection.reasons ?? [];
    const hookRelated = reasons.every((r) => r === "weak_hook" || r === "dead_hook" || r === "housekeeping_open");
    if (hookRelated) {
      const rescue = hookGateRescue(raw, ctx, { rejectionReasons: reasons });
      if (rescue.adoptedRaw) {
        gateJobs.push({ id: c.id, raw: rescue.adoptedRaw, ctx, flag: rescue.flag, original: null, kind: "rescue", tried: rescue.tried });
        continue;
      }
      diagnostics.hookGate.unfixable.push({ id: c.id, span: `${res.rejection.start_id}-${res.rejection.end_id}`, reasons });
      continue;
    }
    diagnostics.codeRejected.push(res.rejection);
  }

  // ---- HOOK GATE (the dedicated AI check, one batched call) ----
  if (gateJobs.length > 0) {
    let gateResults = null;
    try {
      const gateReq = JSON.stringify(
        {
          mode: "hook_gate",
          note: "Judge ONLY the first 3 seconds of each clip. Score 1-10, classify the hook type, verdict fixed or unfixable.",
          judgments: gateJobs.map((j) => {
            const s0 = j.ctx.byNum.get(parseId(j.raw.start_id));
            return {
              id: j.id,
              first_eight_words: (s0?.text ?? "").split(/\s+/).slice(0, 8).join(" "),
            };
          }),
        },
        null,
        2
      );
      const content = await chatComplete(HOOK_GATE_SYSTEM_PROMPT, gateReq, {
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        temperature: CONFIG.MODEL_TEMPERATURE,
      });
      gateResults = parseGateResponse(content);
    } catch (err) {
      diagnostics.judgeErrors.push({ stage: "hook_gate", error: String(err?.message ?? err) });
    }

    for (const job of gateJobs) {
      const verdict = gateResults?.get(job.id) ?? null;
      // Gate verdict wins; a failed/missing gate call degrades to the code
      // estimate (logged) so a gate outage never mass-drops candidates.
      const hookScore = verdict && Number.isFinite(verdict.hook_score)
        ? verdict.hook_score
        : codeHookEstimate(job.raw, job.ctx);
      let finalRes;
      try {
        finalRes = evaluateCandidate(
          {
            ...job.raw,
            scores: { ...job.raw.scores, hook: hookScore },
            hook_type: verdict?.hook_type ?? "none",
          },
          job.ctx
        );
      } catch {
        finalRes = { ok: false };
      }
      if (finalRes.ok && finalRes.clip.intel_json.scores.hook >= CONFIG.HOOK_MIN_STRENGTH) {
        const clip = finalRes.clip;
        clip.intel_json.flags.push(job.flag, `hook_gate_start_moved_to_${clip.start_id}`);
        clip.intel_json.hook_gate = {
          score: hookScore,
          hook_type: verdict?.hook_type ?? "code_estimate",
          verdict: verdict?.verdict ?? "code_estimate",
          why: verdict?.why ?? null,
          tried_starts: job.tried,
          fallback: gateResults ? false : true,
        };
        clip.reason = `${clip.reason} [hook gate: restarted on ${clip.start_id}]`.slice(0, 500);
        if (job.kind === "improve") {
          // Adopt only when the rescue does not make the clip worse.
          if (clip.total >= job.original.total) {
            passing.splice(passing.indexOf(job.original), 1, clip);
            diagnostics.hookGate.rescued.push({ id: job.id, start_id: clip.start_id, score: hookScore });
            if (job.flag === "cold_open") diagnostics.hookGate.coldOpens.push(job.id);
          }
        } else {
          passing.push(clip);
          diagnostics.hookGate.rescued.push({ id: job.id, start_id: clip.start_id, score: hookScore });
          if (job.flag === "cold_open") diagnostics.hookGate.coldOpens.push(job.id);
        }
      } else if (job.kind === "rescue") {
        diagnostics.hookGate.unfixable.push({
          id: job.id,
          span: `${job.raw.start_id}-${job.raw.end_id}`,
          reasons: [`gate verdict ${verdict?.verdict ?? "code_estimate"} hook ${hookScore}`],
        });
      }
      // kind "improve" with a failed rescue keeps the original clip (still in passing).
    }
  }

  // ---- THRESHOLD + RANK ----
  // [A] "a clip with a hook score under 6 cannot rank in the top picks,
  // regardless of its other scores." The gate already rejects those; the
  // partition below is the defensive second half of the rule.
  const above = passing.filter((c) => c.total >= CONFIG.THRESHOLD);
  for (const c of passing) {
    if (c.total < CONFIG.THRESHOLD) {
      diagnostics.belowThreshold.push({ start_id: c.start_id, end_id: c.end_id, total: c.total, clip_type: c.clip_type });
    }
  }
  const hookPartition = (a, b) => {
    const ha = a.intel_json.scores.hook >= CONFIG.HOOK_MIN_STRENGTH ? 0 : 1;
    const hb = b.intel_json.scores.hook >= CONFIG.HOOK_MIN_STRENGTH ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return b.total - a.total;
  };
  const sameIdeaPass = dedupeSameIdea(above.sort(hookPartition));
  diagnostics.sameIdeaDropped = above.length - sameIdeaPass.length;
  let ranked = dedupeClips(sameIdeaPass);
  let picked = pickWithTypeCap(ranked, target);

  // ---- SCOUT (multi-moment composer) ----
  // Strong candidates that did not ship standalone are prime merge material:
  // ranked-but-unpicked clips and just-below-threshold moments both go on the
  // board so the scout can compose one clip out of several scouted moments.
  if (CONFIG.SCOUT_SHOTS && picked.length > 0) {
    const pickedStarts = new Set(picked.map((c) => c.start_id));
    const extraMoments = [];
    const pushMoment = (c, signal) => {
      const a = sentences[parseId(c.start_id) - 1];
      const b = sentences[parseId(c.end_id) - 1];
      if (!a || !b) return;
      const span = b.end - a.start;
      if (span < CONFIG.SCOUT_MIN_LEN || span > CONFIG.SCOUT_MAX_LEN) return;
      if (extraMoments.some((m) => m.id === a.id)) return;
      extraMoments.push({
        t: round2(a.start),
        id: a.id,
        end_id: b.id,
        span_sec: round2(span),
        sc: Math.round((c.total ?? 0) * 10) / 10,
        signals: [signal],
        text: String(c.title ?? c.hook ?? a.text ?? "").slice(0, 120),
      });
    };
    for (const c of ranked) {
      if (!pickedStarts.has(c.start_id)) pushMoment(c, "strong_moment_unpicked");
    }
    for (const c of diagnostics.belowThreshold) {
      if ((c.total ?? 0) >= 4.5) pushMoment(c, "strong_moment_below_threshold");
    }
    const scoutDeps = { sentences, shared, creatorProfile, patterns, diagnostics, extraMoments };
    const scouted = await mapLimit(picked, CONFIG.CHUNK_CONCURRENCY, (clip) =>
      scoutClip(clip, scoutDeps).catch(() => clip)
    );
    picked = dedupeClips(scouted.sort(hookPartition));
    if (picked.length > target) picked = picked.slice(0, target);
  }

  if (typeof onDiagnostics === "function") {
    try { onDiagnostics(diagnostics); } catch { /* diagnostics must never break analysis */ }
  }

  if (picked.length === 0) {
    const why =
      diagnostics.hookGate.unfixable.length > 0
        ? `${diagnostics.hookGate.unfixable.length} candidate(s) failed the hook gate and no rescue passed`
        : diagnostics.skipped[0]?.reason ?? `no candidate reached threshold ${CONFIG.THRESHOLD}`;
    const err = new Error(`clip intelligence returned no usable clips: ${why}`);
    err.diagnostics = diagnostics;
    throw err;
  }

  return picked.map((c) => ({
    start: round2(c.start),                  // outer source bounds
    end: round2(c.end),
    title: c.title,
    hook: c.hook || c.title,
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
 * score/report mode — for the golden set, A/B checks and re-scoring.
 * One judge call for the fixed range; never rejects on duration or
 * threshold — reports hard_fails instead (strict: false).
 */
export async function scoreKnownClip({
  transcriptJson,
  startId,
  endId,
  clipLengthPref = "ai_optimized",
  creatorProfile = null,
  engagementPatterns = [],
  audioSignals = null,
  stylePrefs = [],
}) {
  const { sentences, words, shared, patterns } = prepare({ transcriptJson, clipLengthPref, creatorProfile, engagementPatterns, stylePrefs });
  const s0 = sentences[parseId(startId) - 1];
  const s1 = sentences[parseId(endId) - 1];
  if (!s0 || !s1 || s0.idx > s1.idx) throw new Error(`invalid clip range ${startId}-${endId}`);

  const tagMap = computeEmotionTags(sentences, audioSignals);
  const genre = detectGenre(sentences);
  const judgePrompt = JUDGE_SYSTEM_PROMPT
    .replaceAll("{{GENRE_NOTE}}", GENRE_NOTES[genre.genre] ?? GENRE_NOTES.generic)
    .replaceAll("{{STYLE_NOTE}}", styleNote(shared.stylePrefs));

  const windowSentences = sentences.filter((s) => s.end >= s0.start - 60 && s.start <= s1.end + 30);
  const candidate = {
    id: "C1",
    type: "story",
    s0,
    s1,
    summary: sentences.slice(s0.idx, s1.idx + 1).map((s) => s.text).join(" ").slice(0, 200),
    hook: s0.text,
    why: "",
  };
  const userPrompt = buildJudgeRequest({ candidates: [candidate], sentences: windowSentences, tagMap, genre, creatorProfile, patterns, styles: shared.stylePrefs });

  const content = await chatComplete(judgePrompt, userPrompt, {
    timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
    temperature: CONFIG.MODEL_TEMPERATURE,
  });
  const judged = parseJudgeResponse(content).get("C1");
  if (!judged || judged.unjudged) {
    return { scored: false, rejected: [], skipped_reason: "judge returned no usable result" };
  }

  const ctx = makeWindowContext(windowSentences, shared, { strict: false, enforceDuration: false });
  const res = evaluateCandidate(
    {
      start_id: s0.id,
      end_id: s1.id,
      scenes: null,
      payoff_id: judged.payoff_id,
      type: "story",
      hook: { spoken_text: s0.text },
      summary: candidate.summary,
      titles: judged.titles,
      hook_captions: judged.hook_captions,
      scores: judged.scores,
      hook_type: judged.hook_type,
      primary_emotion: judged.primary_emotion,
      emotion_intensity: judged.emotion_intensity,
      needs_context: judged.needs_context,
      same_idea: judged.same_idea,
      reason: judged.reasoning,
      hashtags: [],
    },
    ctx
  );
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
  hookGateRescue as _hookGateRescue,
  computeEmotionTags as _computeEmotionTags,
  detectGenre as _detectGenre,
  buildFinderRequest as _buildFinderRequest,
  parseFinderResponse as _parseFinderResponse,
  buildJudgeRequest as _buildJudgeRequest,
  parseJudgeResponse as _parseJudgeResponse,
  dedupeSameIdea as _dedupeSameIdea,
  pickWithTypeCap as _pickWithTypeCap,
  dedupeClips as _dedupeClips,
  CONFIG as _CONFIG,
};
