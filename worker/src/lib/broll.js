import { env } from "./env.js";
import { chatComplete, parseJsonArray } from "./zai.js";

/**
 * AI B-roll insertion:
 *   1. Segment the clip-local transcript and pick visually rich moments (LLM)
 *   2. Resolve keywords to vertical stock clips (Pexels → Pixabay fallback)
 * Results are cached per keyword for 24h to keep API usage low.
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

const brollCache = new Map(); // keyword → { url, ts }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function brollConfigured() {
  return Boolean(env.pexelsApiKey || env.pixabayApiKey);
}

const STOCK_HOST_RE = /(^|\.)(pexels\.com|pixabay\.com)$/i;

/** B-roll URLs may only come from the stock providers we searched. */
export function isTrustedStockUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    return parsed.protocol === "https:" && STOCK_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Plan B-roll segments for a clip window and resolve each to a stock video URL.
 * Returns clip-local [{ start, end, src }] — never throws (B-roll is an
 * enhancement; any failure degrades to no B-roll).
 */
export async function planBroll({ transcriptJson, clipStart, clipEnd, durationSeconds, log }) {
  if (!brollConfigured() || !env.zaiApiKey) return [];

  try {
    const duration = Math.max(3, Number(durationSeconds ?? clipEnd - clipStart));
    const words = (transcriptJson?.words ?? []).filter(
      (w) => Number(w.end) > clipStart && Number(w.start) < clipEnd
    );
    if (words.length === 0) return [];

    const transcriptText = words
      .map((w) => `[${(Number(w.start) - clipStart).toFixed(1)}s] ${w.word}`)
      .join(" ")
      .slice(0, 60_000);

    const userPrompt = `Clip duration: ${duration.toFixed(1)} seconds.
Transcript with word timestamps (relative to clip start):
${transcriptText}`;

    const content = await chatComplete(PLANNER_SYSTEM_PROMPT, userPrompt, { timeoutMs: 60_000 });
    const parsed = parseJsonArray(content);

    const maxCoverage = duration * 0.4;
    let coverage = 0;
    const planned = [];
    let lastEnd = -Infinity;

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
        start < 2 || // keep the hook on-camera
        end <= start ||
        end - start > 6 ||
        start < lastEnd + 3 || // spacing rule
        end > duration
      ) {
        continue;
      }
      if (coverage + (end - start) > maxCoverage) break;
      coverage += end - start;
      lastEnd = end;
      planned.push({ start, end, keywords });
    }

    if (planned.length === 0) return [];

    // Resolve keywords → stock URLs (sequential; usually 0-3 lookups).
    const resolved = [];
    for (const seg of planned) {
      let src = null;
      for (const keyword of seg.keywords) {
        src = await searchBrollClip(keyword);
        if (src) break;
      }
      if (src) resolved.push({ start: seg.start, end: seg.end, src });
    }

    log?.(`B-roll: ${resolved.length}/${planned.length} segments resolved to stock clips`);
    return resolved;
  } catch (err) {
    log?.(`B-roll planning failed (continuing without it): ${err.message}`);
    return [];
  }
}

/** Pexels first, Pixabay fallback. Returns a direct mp4 URL or null. */
export async function searchBrollClip(keyword) {
  const cached = brollCache.get(keyword);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.url;

  let url = null;
  if (env.pexelsApiKey) url = await searchPexels(keyword);
  if (!url && env.pixabayApiKey) url = await searchPixabay(keyword);

  brollCache.set(keyword, { url, ts: Date.now() });
  return url;
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
      if (pick?.link) return pick.link;
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
      if (pick?.url) return pick.url;
    }
    return null;
  } catch {
    return null;
  }
}
