import { env } from "../config/env.js";

/**
 * AI enhancements for the clip editor: B-roll planning and music mood
 * picking. Mirrors the worker's integrations (z.ai chat + Pexels/Pixabay
 * stock search) but runs synchronously in the request path.
 */

const PLANNER_SYSTEM_PROMPT = `You are a video editor planning B-roll cutaways for a vertical short clip.

STRICT RULES:
1. Respond with ONLY a JSON array. No markdown, no code fences, no commentary.
2. Each element must have exactly these keys:
   {"start": <seconds:number>, "end": <seconds:number>, "keywords": [<string>, ...]}
3. "start"/"end" are seconds relative to the START of the provided clip window (0 = clip start).
4. Insert B-roll during descriptive or narrative moments — never during direct-to-camera hooks or calls to action.
5. Never insert B-roll in the first 2 seconds (keep the hook on-camera).
6. Space B-roll segments at least 3 seconds apart. B-roll must cover at most 40% of the clip.
7. Each segment is 2-5 seconds long. "keywords" has 1-3 concrete visual search terms (objects, actions, places — e.g. "city traffic", "person typing laptop").
8. If the clip has no moments that benefit from B-roll, respond with [].`;

const MOOD_SYSTEM_PROMPT = `You pick background music for a vertical short clip.

STRICT RULES:
1. Respond with ONLY a JSON object: {"mood": "<one of the listed moods>"}.
2. No markdown, no commentary.
3. Choose the mood that best matches the tone and energy of the transcript for instrumental background music.`;

export function aiConfigured() {
  return Boolean(env.zaiApiKey);
}

export function brollConfigured() {
  return Boolean(env.pexelsApiKey || env.pixabayApiKey);
}

async function chatComplete(systemPrompt, userPrompt, { timeoutMs = 60_000, temperature = 0.4 } = {}) {
  if (!env.zaiApiKey) throw new Error("ZAI_API_KEY is not configured");

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
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`z.ai API failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json())?.choices?.[0]?.message?.content ?? "";
}

function parseJson(content) {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const start = Math.min(
    ...[cleaned.indexOf("["), cleaned.indexOf("{")].filter((i) => i !== -1)
  );
  const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  if (!Number.isFinite(start) || end <= start) {
    throw new Error("AI response did not contain JSON");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

const STOCK_HOST_RE = /(^|\.)(pexels\.com|pixabay\.com)$/i;

function isTrustedStockUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    return parsed.protocol === "https:" && STOCK_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function searchPexels(query) {
  try {
    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=5`,
      { headers: { Authorization: env.pexelsApiKey }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    for (const video of data?.videos ?? []) {
      const files = (video.video_files ?? [])
        .filter((f) => f.file_type === "video/mp4" && Number(f.height) >= Number(f.width))
        .sort((a, b) => Number(a.height) - Number(b.height));
      const pick = files.find((f) => Number(f.height) >= 1280) ?? files[files.length - 1];
      if (pick?.link && isTrustedStockUrl(pick.link)) return pick.link;
    }
    return null;
  } catch {
    return null;
  }
}

async function searchPixabay(query) {
  try {
    const res = await fetch(
      `https://pixabay.com/api/videos/?key=${encodeURIComponent(env.pixabayApiKey)}&q=${encodeURIComponent(query)}&orientation=vertical&per_page=5`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    for (const hit of data?.hits ?? []) {
      const files = hit.videos ?? {};
      const pick = files.large ?? files.medium ?? files.small;
      if (pick?.url && isTrustedStockUrl(pick.url)) return pick.url;
    }
    return null;
  } catch {
    return null;
  }
}

async function searchBrollClip(keyword) {
  let url = null;
  if (env.pexelsApiKey) url = await searchPexels(keyword);
  if (!url && env.pixabayApiKey) url = await searchPixabay(keyword);
  return url;
}

/**
 * Multi-result stock search for the editor's keyword/category picker.
 * Returns [{url, poster, provider, duration}] — poster is only available
 * from Pexels; Pixabay results render a placeholder tile.
 */
export async function searchStockClips(query, perPage = 12) {
  const results = [];
  if (env.pexelsApiKey) {
    try {
      const res = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=${perPage}`,
        { headers: { Authorization: env.pexelsApiKey }, signal: AbortSignal.timeout(10_000) }
      );
      if (res.ok) {
        const data = await res.json();
        for (const video of data?.videos ?? []) {
          const files = (video.video_files ?? [])
            .filter((f) => f.file_type === "video/mp4" && Number(f.height) >= Number(f.width))
            .sort((a, b) => Number(a.height) - Number(b.height));
          const pick = files.find((f) => Number(f.height) >= 1280) ?? files[files.length - 1];
          if (pick?.link && isTrustedStockUrl(pick.link)) {
            results.push({
              url: pick.link,
              poster: typeof video.image === "string" ? video.image : null,
              provider: "pexels",
              duration: Number(video.duration ?? 0),
            });
          }
        }
      }
    } catch {
      // fall through to pixabay
    }
  }
  if (results.length === 0 && env.pixabayApiKey) {
    try {
      const res = await fetch(
        `https://pixabay.com/api/videos/?key=${encodeURIComponent(env.pixabayApiKey)}&q=${encodeURIComponent(query)}&orientation=vertical&per_page=${perPage}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (res.ok) {
        const data = await res.json();
        for (const hit of data?.hits ?? []) {
          const files = hit.videos ?? {};
          const pick = files.large ?? files.medium ?? files.small;
          if (pick?.url && isTrustedStockUrl(pick.url)) {
            results.push({
              url: pick.url,
              poster: null,
              provider: "pixabay",
              duration: Number(hit.duration ?? 0),
            });
          }
        }
      }
    } catch {
      // no results
    }
  }
  return results.slice(0, perPage);
}

/**
 * Plan B-roll for a clip window. Returns clip-local [{start,end,src}]
 * (throws on AI/parse failure — the caller decides how to degrade).
 */
export async function planBrollSegments({ transcriptJson, clipStart, clipEnd, durationSeconds }) {
  const duration = Math.max(3, Number(durationSeconds ?? clipEnd - clipStart));
  const words = (transcriptJson?.words ?? []).filter(
    (w) => Number(w.end) > clipStart && Number(w.start) < clipEnd
  );
  if (words.length === 0) return [];

  const transcriptText = words
    .map((w) => `[${(Number(w.start) - clipStart).toFixed(1)}s] ${w.word}`)
    .join(" ")
    .slice(0, 60_000);

  const content = await chatComplete(
    PLANNER_SYSTEM_PROMPT,
    `Clip duration: ${duration.toFixed(1)} seconds.
Transcript with word timestamps (relative to clip start):
${transcriptText}`
  );
  const parsed = parseJson(content);
  if (!Array.isArray(parsed)) throw new Error("AI returned no B-roll plan");

  const maxCoverage = duration * 0.4;
  let coverage = 0;
  let lastEnd = -Infinity;
  const planned = [];

  for (const seg of parsed.slice(0, 6)) {
    const start = Number(seg.start ?? -1);
    const end = Number(seg.end ?? -1);
    const keywords = (Array.isArray(seg.keywords) ? seg.keywords : [])
      .map((k) => String(k).trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 3);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      keywords.length === 0 ||
      start < 2 ||
      end <= start ||
      end - start > 6 ||
      start < lastEnd + 3 ||
      end > duration
    ) {
      continue;
    }
    if (coverage + (end - start) > maxCoverage) break;
    coverage += end - start;
    lastEnd = end;
    planned.push({ start, end, keywords });
  }

  const resolved = [];
  for (const seg of planned) {
    let src = null;
    for (const keyword of seg.keywords) {
      src = await searchBrollClip(keyword);
      if (src) break;
    }
    if (src) resolved.push({ start: seg.start, end: seg.end, src });
  }
  return resolved;
}

/**
 * Pick a music mood for a clip transcript. Returns one of `moods`
 * (throws on AI/parse failure).
 */
export async function pickMusicMood({ transcriptText, moods }) {
  const content = await chatComplete(
    MOOD_SYSTEM_PROMPT,
    `Available moods: ${moods.join(", ")}.

Clip transcript:
${String(transcriptText).slice(0, 8000)}`,
    { temperature: 0.2, timeoutMs: 30_000 }
  );
  const parsed = parseJson(content);
  const mood = String(parsed?.mood ?? "").trim().toLowerCase();
  if (!moods.includes(mood)) throw new Error(`AI picked an unknown mood: ${mood}`);
  return mood;
}
