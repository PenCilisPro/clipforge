import { env } from "./env.js";

const CLIP_LENGTH_RULES = {
  "10-14": "Each clip must be 10-14 seconds long.",
  "15-30": "Each clip must be 15-30 seconds long.",
  "31-45": "Each clip must be 31-45 seconds long.",
  "60+": "Each clip must be at least 60 seconds long (60-90 seconds is ideal).",
  ai_optimized: "Each clip must be 15-60 seconds long.",
};

const SYSTEM_PROMPT = `You are a short-form video strategist. You receive the word-level transcript of a long-form video (podcast, webinar, or YouTube video) and must identify the segments most likely to go viral as vertical short-form clips (TikTok / Reels / Shorts).

STRICT RULES:
1. Respond with ONLY a JSON array. No markdown, no code fences, no commentary.
2. Each element must have exactly these keys:
   {"start": <seconds:number>, "end": <seconds:number>, "title": <string>, "hook": <string>, "virality_score": <0-100 number>, "reason": <string>, "hashtags": [<string>, ...]}
3. "start" and "end" are seconds within the video. CLIP_LENGTH_RULE and must not extend beyond the video duration.
4. "end" MUST fall right after a spoken sentence finishes (a word ending with ".", "!" or "?") — never mid-sentence or mid-word. If ending the sentence would exceed the requested length, move "start" later (trim from the front) rather than cutting the sentence short.
5. Choose moments that are self-contained: a complete thought, story, or insight with a strong hook in the first 3 seconds.
6. "title" is a punchy title (max 60 chars). "hook" is a first-line caption for posting (max 100 chars). "hashtags" has 3-5 lowercase items without spaces.
7. Score 90+ only for exceptional, highly shareable moments. Rank clips by virality_score, best first.
8. Return at most the number of clips requested. If the transcript is too short or bland, return fewer clips.`;

/**
 * One bounded chat completion against the z.ai OpenAI-compatible API.
 * Shared by viral-clip detection and B-roll planning.
 */
export async function chatComplete(systemPrompt, userPrompt, { timeoutMs = 120_000, temperature = 0.4 } = {}) {
  if (!env.zaiApiKey) {
    throw new Error("ZAI_API_KEY is not configured");
  }

  const res = await fetch(`${env.zaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.zaiApiKey}`,
    },
    body: JSON.stringify({
      model: env.zaiModel,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    // Bound the call — a stalled provider must not wedge the pipeline.
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`z.ai API failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Parse a JSON array out of a model response, tolerating code fences. */
export function parseJsonArray(content) {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error("response did not contain a JSON array");
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response was not a JSON array");
  return parsed;
}

/**
 * Ask z.ai (Zhipu GLM, OpenAI-compatible API) for clip suggestions.
 * Returns a validated array of clip segments.
 */
export async function detectViralClips({
  transcriptJson,
  durationSeconds,
  maxClips,
  clipLengthPref = "ai_optimized",
}) {
  const lengthRule = CLIP_LENGTH_RULES[clipLengthPref] ?? CLIP_LENGTH_RULES.ai_optimized;
  const systemPrompt = SYSTEM_PROMPT.replace("CLIP_LENGTH_RULE", lengthRule);

  const words = transcriptJson?.words ?? [];
  const transcriptText = words
    .map((w) => `[${Number(w.start).toFixed(1)}s] ${w.word}`)
    .join(" ")
    .slice(0, 180_000); // stay comfortably under the context window

  const userPrompt = `Video duration: ${Math.round(durationSeconds)} seconds.
Find up to ${maxClips} clips.

Transcript with word timestamps:
${transcriptText}`;

  const content = await chatComplete(systemPrompt, userPrompt);
  return parseClipJson(content, durationSeconds, maxClips, clipLengthPref, words);
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

const SENTENCE_END_RE = /[.!?…]["')\]»]*$/;

export { snapToBounds };

/**
 * Snap a suggested clip onto the word-level transcript so it ends on a
 * completed word — and, within a few seconds' grace, on a completed sentence:
 * - `end` never cuts a word. If the sentence runs a little past the suggested
 *   end, `end` stretches to the sentence's last word.
 * - Stretching may push the clip past the requested max length; the FRONT is
 *   then clipped shorter (start moves later) so the ending always survives —
 *   an unfinished sentence is worse than a trimmed intro.
 * - `start` snaps back to the beginning of the word it lands in, so the first
 *   word isn't cut mid-word either.
 */
function snapToBounds(clip, words, { min, max }) {
  if (!Array.isArray(words) || words.length === 0) return clip;

  const GRACE = 3.5; // seconds `end` may hunt forward for a sentence end

  // Last word that starts inside the clip window.
  let lastIdx = -1;
  for (let i = 0; i < words.length; i++) {
    if (Number(words[i].start) < clip.end) lastIdx = i;
    else break;
  }
  if (lastIdx === -1) return clip;

  // 1. Never end mid-word.
  let end = Math.max(clip.end, Number(words[lastIdx].end));

  // 2. If the suggested end lands mid-sentence, stretch to the next
  //    sentence-ending word within the grace window.
  if (!SENTENCE_END_RE.test(String(words[lastIdx].word))) {
    for (let i = lastIdx + 1; i < words.length; i++) {
      const w = words[i];
      if (Number(w.start) > clip.end + GRACE) break;
      if (Number(w.end) - clip.start > max + GRACE) break;
      if (SENTENCE_END_RE.test(String(w.word))) {
        end = Math.max(end, Number(w.end));
        break;
      }
    }
  }

  // 3. Over the requested length now? Shorten from the front.
  let start = clip.start;
  if (end - start > max) start = end - max;

  // 4. Don't cut the first word in half: pull the start back to the start of
  //    the word containing it (or skip that word when pulling would overgrow
  //    the clip again).
  for (let i = 0; i < words.length; i++) {
    const wStart = Number(words[i].start);
    const wEnd = Number(words[i].end);
    if (wStart <= start && start < wEnd) {
      if (end - Math.max(0, wStart) <= max + 1.5) start = Math.max(0, wStart);
      else start = wEnd;
      break;
    }
    if (wStart > start) break;
  }

  // 5. Length sanity: keep at least `min` seconds of content.
  start = Math.max(0, start);
  if (end - start < min) end = start + min;

  return { ...clip, start, end };
}

function parseClipJson(content, durationSeconds, maxClips, clipLengthPref, words = []) {
  let parsed;
  try {
    parsed = parseJsonArray(content);
  } catch {
    throw new Error("z.ai returned malformed JSON");
  }

  const { min, max } = prefBounds(clipLengthPref);

  const clips = parsed
    .map((c) => ({
      start: Math.max(0, Number(c.start ?? 0)),
      end: Number(c.end ?? 0),
      title: String(c.title ?? "Untitled clip").slice(0, 80),
      hook: String(c.hook ?? "").slice(0, 160),
      virality_score: Math.min(100, Math.max(0, Number(c.virality_score ?? 50))),
      reason: String(c.reason ?? "").slice(0, 500),
      hashtags: Array.isArray(c.hashtags)
        ? c.hashtags.slice(0, 5).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean)
        : [],
    }))
    .filter((c) => c.end > c.start)
    // Respect the requested clip length (with a little tolerance), nudging
    // near-misses into range instead of discarding them.
    .map((c) => {
      const dur = c.end - c.start;
      if (dur > max) c.end = c.start + max;
      else if (dur < min) {
        const extended = c.start + min;
        if (!durationSeconds || extended <= durationSeconds) c.end = extended;
      }
      return c;
    })
    // Land the boundaries on real words / finished sentences.
    .map((c) => snapToBounds(c, words, { min, max }))
    .filter((c) => c.end - c.start >= Math.min(min, 8))
    .map((c) => ({
      ...c,
      end: Math.min(c.end, durationSeconds || c.end),
      start: Math.min(c.start, Math.max(0, (durationSeconds || c.end) - 8)),
    }))
    .slice(0, maxClips);

  if (clips.length === 0) {
    throw new Error("z.ai returned no usable clips");
  }
  return clips;
}
