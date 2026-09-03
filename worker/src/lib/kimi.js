import { env } from "./env.js";

const SYSTEM_PROMPT = `You are a short-form video strategist. You receive the word-level transcript of a long-form video (podcast, webinar, or YouTube video) and must identify the segments most likely to go viral as vertical short-form clips (TikTok / Reels / Shorts).

STRICT RULES:
1. Respond with ONLY a JSON array. No markdown, no code fences, no commentary.
2. Each element must have exactly these keys:
   {"start": <seconds:number>, "end": <seconds:number>, "title": <string>, "hook": <string>, "virality_score": <0-100 number>, "reason": <string>, "hashtags": [<string>, ...]}
3. "start" and "end" are seconds within the video. Each clip must be 15-60 seconds long and must not extend beyond the video duration.
4. Choose moments that are self-contained: a complete thought, story, or insight with a strong hook in the first 3 seconds.
5. "title" is a punchy title (max 60 chars). "hook" is a first-line caption for posting (max 100 chars). "hashtags" has 3-5 lowercase items without spaces.
6. Score 90+ only for exceptional, highly shareable moments. Rank clips by virality_score, best first.
7. Return at most the number of clips requested. If the transcript is too short or bland, return fewer clips.`;

/**
 * Ask Kimi (Moonshot AI, OpenAI-compatible API) for clip suggestions.
 * Returns a validated array of clip segments.
 */
export async function detectViralClips({ transcriptJson, durationSeconds, maxClips }) {
  if (!env.kimiApiKey) {
    throw new Error("KIMI_API_KEY is not configured");
  }

  const words = transcriptJson?.words ?? [];
  const transcriptText = words
    .map((w) => `[${Number(w.start).toFixed(1)}s] ${w.word}`)
    .join(" ")
    .slice(0, 180_000); // stay comfortably under the context window

  const userPrompt = `Video duration: ${Math.round(durationSeconds)} seconds.
Find up to ${maxClips} clips.

Transcript with word timestamps:
${transcriptText}`;

  const res = await fetch(`${env.kimiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.kimiApiKey}`,
    },
      body: JSON.stringify({
        model: env.kimiModel,
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      // Bound the call — a stalled provider must not wedge the analyze stage.
      signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`Kimi API failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return parseClipJson(content, durationSeconds, maxClips);
}

function parseClipJson(content, durationSeconds, maxClips) {
  // Strip code fences if the model added them despite instructions.
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error("Kimi response did not contain a JSON array");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("Kimi returned malformed JSON");
  }

  const clips = (Array.isArray(parsed) ? parsed : [])
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
    .filter((c) => c.end > c.start && c.end - c.start >= 8)
    .map((c) => ({
      ...c,
      end: Math.min(c.end, durationSeconds || c.end),
      start: Math.min(c.start, Math.max(0, (durationSeconds || c.end) - 8)),
    }))
    .slice(0, maxClips);

  if (clips.length === 0) {
    throw new Error("Kimi returned no usable clips");
  }
  return clips;
}
