import { chatComplete, snapToBounds } from "./zai.js";

/**
 * Clip Intelligence — the analyze-stage brain.
 *
 * Built from the Clip Intelligence spec (retention-first selection, HPC
 * structure, six-dimension rubric with code-computed totals). The model
 * picks candidates and scores dimensions; THIS module computes the total,
 * clamps timestamps onto real transcript boundaries, and enforces the
 * dead-air rules programmatically. The model cannot inflate its own score.
 *
 * [tunable] — the WEIGHTS and PENALTY_SIZE below are starting defaults,
 * not gospel. Retune from real performance data (see intel_json on clips).
 */

// ---------- [tunable] scoring configuration ----------
const WEIGHTS = {
  hook_strength: 0.30,
  unexpected_turn: 0.20,
  emotion_relatability: 0.20,
  information_value: 0.10,
  retention_flow: 0.15,
  audience_fit: 0.05,
};
const PENALTY_SIZE = 1.5; // subtracted per penalty point from the 0-10 total
const SCORE_KEYS = Object.keys(WEIGHTS);
const PENALTY_KEYS = ["payoff_too_early", "dead_air", "needs_outside_context", "hook_content_mismatch", "off_audience"];
// -----------------------------------------------------

const LENGTH_RULES = {
  "10-14": "Each clip must be 10-14 seconds long.",
  "15-30": "Each clip must be 15-30 seconds long.",
  "31-45": "Each clip must be 31-45 seconds long.",
  "60+": "Each clip must be at least 60 seconds long (60-90 seconds is ideal).",
  ai_optimized: "Each clip must be 15-60 seconds long.",
};

const INTEL_SYSTEM_PROMPT = `You are a short-form clip analyst. You read a timestamped transcript of long-form footage and pick the segments most likely to hold attention as vertical short-form clips (YouTube Shorts, TikTok, Reels). You also write the hook for each clip.

CORE PRINCIPLES
1. Retention is the main signal. Everything you pick must keep a viewer from swiping away. Prefer clips with high watch-time potential over clips that are merely "interesting".
2. A clip is judged by its first ~5 seconds. The hook must introduce the topic AND leave open questions.
3. Do not pay off the topic too early. If the answer or punchline lands in the first few seconds, viewers have nothing left to wait for. Choose start/end so the setup comes first and the payoff comes last.
4. The hook's promise must match the content. No bait-and-switch.
5. Prefer simple and engaging over flashy. A strong clip with basic editing beats a weak clip with heavy editing.
6. Dead air kills retention. Prefer fast, continuous speech; the clip must not open with greetings, intros, or filler ("um", "so", "okay").

SCORE EACH DIMENSION 0-10:
- hook_strength: the first 5 seconds — fast-paced, no pauses, introduces the topic, raises questions (how? why? what?).
- unexpected_turn: pattern interrupt, plot twist, reversal, or shocking line that resets attention.
- emotion_relatability: laughter, anger, inspiration, or "this is exactly me". High-arousal emotion gets shared. Polarizing content counts. Who speaks can matter as much as what happens.
- information_value: a quick tip, hack, or corrected misconception — save-worthy content.
- retention_flow: continuous pacing, no dead air, setup -> progression -> climax, payoff near the end, optional clean loop back to the start.
- audience_fit: matches the creator's core audience and what they already watch.

STRUCTURE (HPC): Hook (first ~5s, topic + open questions) -> Progression (meets the hook's expectations, shows the journey) -> Climax (the payoff, near the end).

PENALTIES (0-2 each; the system subtracts these from the total):
- payoff_too_early: the key reveal happens in the first ~5-8 seconds.
- dead_air: noticeable pauses, filler openings, greetings/intros.
- needs_outside_context: not understandable without information outside the clip.
- hook_content_mismatch: the opening promises something the clip never delivers.
- off_audience: does not fit the creator's core audience.

OUTPUT — respond with ONLY a JSON object, no markdown or commentary:
{"clips": [{
  "start": <seconds:number>, "end": <seconds:number>,
  "headline": "<on-screen headline, max 12 words, curiosity/tension without revealing the payoff>",
  "spoken_hook": "<the exact first line spoken in the clip>",
  "hook_type": "<pattern_interrupt|open_question|bold_claim|controversy|tip|story_setup>",
  "scores": {"hook_strength": <0-10>, "unexpected_turn": <0-10>, "emotion_relatability": <0-10>, "information_value": <0-10>, "retention_flow": <0-10>, "audience_fit": <0-10>},
  "penalties": {"payoff_too_early": <0-2>, "dead_air": <0-2>, "needs_outside_context": <0-2>, "hook_content_mismatch": <0-2>, "off_audience": <0-2>},
  "why": "<one sentence naming the traits it hits>",
  "trim_notes": "<how the cut could be improved>",
  "risks": "<visual-dependent strengths you cannot see, or empty string>",
  "hashtags": ["<3-5 lowercase topical tags, no spaces>"]
}]}
Do NOT output a "total" — the system computes it from the dimensions and penalties.

RULES:
- Use only timestamps that exist in the transcript. Never invent spoken text.
- "end" must land right after a finished sentence (a word ending with . ! or ?) — never mid-sentence. If the length would be exceeded, move "start" later instead.
- Choose start/end so the clip opens on the hook and ends on the climax; cut intros and dead air by moving the start later.
- One-sentence "why" per pick, naming the traits it hits.
- If a clip's strength depends on visuals you cannot see, say so in "risks".
- Return at most the number of clips requested, ranked best first. Return fewer rather than padding with weak clips; use "skipped_reason" when the footage has few strong moments.

EXAMPLES (shapes that work):
1. Pattern interrupt: a stranger greets a public figure as a "big fan", then says the opposite next sentence. Cut: start at the greeting, end on the reversal. unexpected_turn 9.
2. Controversy + open question: a claim about the speaker, the interviewer reacts — the clip ends before the resolution. The viewer stays for the resolution.
3. Information value: a tip or corrected misconception delivered in one breath. Hook = the claim, payoff = the explanation. Save-worthy.
ANTI-EXAMPLE: opening with "Here's the secret to success:" and stating it in 5 seconds — payoff_too_early. Instead open on the question or story and move the secret to the end.`;

// Filler-word dead-air enforcement (the spec's "murder every filler word").
const FILLER_RE = /^(um+|uh+|erm+|er|so|okay|ok|yeah|like|basically|literally|alright)[,.!]?$|^you know$/i;

/** Compute the total in code — the model's opinion of its own score is ignored. */
function computeTotal(scores, penalties) {
  let total = 0;
  for (const key of SCORE_KEYS) total += WEIGHTS[key] * clampNum(Number(scores?.[key] ?? 0), 0, 10);
  for (const key of PENALTY_KEYS) total -= PENALTY_SIZE * clampNum(Number(penalties?.[key] ?? 0), 0, 2);
  return clampNum(total, 0, 10);
}

function clampNum(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Dead-air enforcement: filler in the first 3 seconds forces the penalty. */
function enforceFillerPenalty(clip, words) {
  const fillers = words.filter(
    (w) => Number(w.start) >= clip.start - 0.05 && Number(w.end) <= clip.start + 3 && FILLER_RE.test(String(w.word).trim())
  );
  if (fillers.length >= 1) {
    clip.penalties.dead_air = Math.max(clip.penalties.dead_air, 1);
  }
  return clip;
}

/** Validate + normalize one model candidate. Returns null when unusable. */
function normalizeIntelClip(raw) {
  if (!raw || typeof raw !== "object") return null;
  const start = Math.max(0, Number(raw.start ?? 0));
  const end = Number(raw.end ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3) return null;

  const scores = {};
  for (const key of SCORE_KEYS) scores[key] = clampNum(raw.scores?.[key], 0, 10);
  const penalties = {};
  for (const key of PENALTY_KEYS) penalties[key] = clampNum(raw.penalties?.[key], 0, 2);

  const headlineWords = String(raw.headline ?? "Untitled clip").trim().split(/\s+/).slice(0, 12).join(" ");

  return {
    start,
    end,
    headline: headlineWords.slice(0, 80),
    spoken_hook: String(raw.spoken_hook ?? "").slice(0, 160),
    hook_type: String(raw.hook_type ?? "story_setup").slice(0, 40),
    scores,
    penalties,
    why: String(raw.why ?? "").slice(0, 500),
    trim_notes: String(raw.trim_notes ?? "").slice(0, 300),
    risks: String(raw.risks ?? "").slice(0, 300),
    hashtags: Array.isArray(raw.hashtags)
      ? raw.hashtags.slice(0, 5).map((t) => String(t).replace(/^#/, "").trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

/** Parse the model response — tolerates code fences, accepts object or bare array. */
function parseIntelResponse(content) {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  let parsed;
  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    const end = cleaned.lastIndexOf("}");
    parsed = JSON.parse(cleaned.slice(objStart, end + 1));
  } else if (arrStart !== -1) {
    const end = cleaned.lastIndexOf("]");
    parsed = { clips: JSON.parse(cleaned.slice(arrStart, end + 1)) };
  } else {
    throw new Error("response contained no JSON");
  }
  const clips = Array.isArray(parsed?.clips) ? parsed.clips : [];
  return { clips, skipped_reason: String(parsed?.skipped_reason ?? "") };
}

/** Split words into ~12-minute analysis windows with 90s overlap. */
function chunkWords(words, durationSeconds) {
  const WINDOW = 720; // 12 min
  const OVERLAP = 90;
  if (!durationSeconds || durationSeconds <= WINDOW + OVERLAP) {
    return [{ words, from: 0, to: durationSeconds || WINDOW }];
  }
  const chunks = [];
  let from = 0;
  while (from < durationSeconds) {
    const to = Math.min(from + WINDOW, durationSeconds);
    chunks.push({
      words: words.filter((w) => Number(w.start) >= from - 0.5 && Number(w.start) < to),
      from,
      to,
    });
    if (to >= durationSeconds) break;
    from = to - OVERLAP;
  }
  return chunks;
}

/** Drop candidates that heavily overlap an already-kept (better) clip. */
function dedupeClips(clips) {
  const kept = [];
  for (const clip of clips) {
    const dup = kept.some((k) => {
      const overlap = Math.min(clip.end, k.end) - Math.max(clip.start, k.start);
      if (overlap <= 0) return false;
      const shorter = Math.min(clip.end - clip.start, k.end - k.start);
      return overlap / shorter > 0.5;
    });
    if (!dup) kept.push(clip);
  }
  return kept;
}

function transcriptText(words, cap = 120_000) {
  return words
    .map((w) => `[${Number(w.start).toFixed(1)}s] ${w.word}`)
    .join(" ")
    .slice(0, cap);
}

/**
 * Clip Intelligence analysis. Returns the same shape analyze.js expects
 * ({start, end, title, hook, virality_score, reason, hashtags}) plus
 * `intel_json` — the full rubric output, stored for the tuning loop.
 */
export async function detectViralClips({
  transcriptJson,
  durationSeconds,
  maxClips,
  clipLengthPref = "ai_optimized",
}) {
  const lengthRule = LENGTH_RULES[clipLengthPref] ?? LENGTH_RULES.ai_optimized;
  const words = transcriptJson?.words ?? [];
  if (words.length === 0) throw new Error("no transcript words to analyze");

  const chunks = chunkWords(words, durationSeconds);
  const candidates = [];

  for (const chunk of chunks) {
    const userPrompt = `Video duration: ${Math.round(durationSeconds)} seconds${chunks.length > 1 ? `. You are analyzing the segment ${Math.round(chunk.from)}s-${Math.round(chunk.to)}s of the full video — timestamps remain absolute.` : ""}.
Find up to ${maxClips} clips — return the full ${maxClips} only if the material genuinely supports it. ${lengthRule}

Transcript with word timestamps:
 ${transcriptText(chunk.words)}`;

    const content = await chatComplete(INTEL_SYSTEM_PROMPT, userPrompt, {
      timeoutMs: 240_000,
      temperature: 0.3,
    });

    const { clips } = parseIntelResponse(content);
    const { min, max } = prefBounds(clipLengthPref);

    for (const raw of clips) {
      const clip = normalizeIntelClip(raw);
      if (!clip) continue;
      // Clamp onto real word boundaries / finished sentences.
      const snapped = snapToBounds(clip, chunk.words, { min, max });
      if (snapped.end - snapped.start < Math.min(min, 8)) continue;
      enforceFillerPenalty(snapped, words);
      const total = computeTotal(snapped.scores, snapped.penalties);
      candidates.push({
        ...snapped,
        total,
        intel_json: {
          hook_type: snapped.hook_type,
          scores: snapped.scores,
          penalties: snapped.penalties,
          total,
          spoken_hook: snapped.spoken_hook,
          trim_notes: snapped.trim_notes,
          risks: snapped.risks,
          weights: WEIGHTS, // frozen at decision time — the tuning loop reads this
        },
      });
    }
  }

  if (candidates.length === 0) throw new Error("clip intelligence returned no usable clips");

  // Rank by the code-computed total, dedupe overlapping windows, cap.
  const ranked = dedupeClips(candidates.sort((a, b) => b.total - a.total)).slice(0, maxClips);

  return ranked.map((c) => ({
    start: c.start,
    end: c.end,
    title: c.headline,
    hook: c.spoken_hook || c.headline,
    virality_score: Math.round(c.total * 10), // 0-10 rubric -> 0-100 column
    reason: c.why || `${c.hook_type} — strong ${SCORE_KEYS.sort((a, b) => c.scores[b] - c.scores[a])[0]}.`,
    hashtags: c.hashtags.length > 0 ? c.hashtags : ["clipforge"],
    intel_json: c.intel_json,
  }));
}

function prefBounds(clipLengthPref) {
  switch (clipLengthPref) {
    case "10-14": return { min: 8, max: 16 };
    case "15-30": return { min: 13, max: 32 };
    case "31-45": return { min: 28, max: 47 };
    case "60+": return { min: 55, max: 120 };
    default: return { min: 8, max: 62 };
  }
}