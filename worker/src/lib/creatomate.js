import { env } from "./env.js";
import { captionFont, RENDER_STYLES } from "./captions.js";

const API_BASE = "https://api.creatomate.com/v2";
const RENDER_ID_RE = /^[A-Za-z0-9-]+$/;

/**
 * Creatomate render provider (https://creatomate.com).
 *
 * Renders are described as a RenderScript JSON document posted to
 * POST /v2/renders (raw RenderScript at the top level, render options like
 * `webhook_url` alongside it). Poll GET /v2/renders/:id for
 * planned | waiting | transcribing | rendering | succeeded | failed |
 * cancelled; completion also arrives via `webhook_url` with the render
 * object as the body. No watermarks on any plan.
 *
 * LAYERING: higher track numbers render on top (the inverse of Shotstack).
 * Track 1 main video → 2 b-roll cutaways → 3 watermark → 4 captions.
 *
 * Captions are native text elements — stroke, drop shadow, and background
 * boxes are supported directly (no underlay-copy hacks). Custom TTFs load
 * via the root `fonts` array and are matched by exact family + weight +
 * style, so each family is registered at weight 400 with the element
 * font_weight left at its default. Word-sync highlighting uses inline
 * [color …]/[opacity …] spans: one text element per spoken word with the
 * active word accented, same scheme as the Shotstack HTML clips.
 */

// Visual translation of the caption templates in captions.js lives in
// RENDER_STYLES there (shared with the local ffmpeg provider).

const MAX_WORD_ELEMENTS = 400;
const CAPTION_TRACK = 4;
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled"]);

function captionStyleDef(style) {
  return RENDER_STYLES[style] ?? RENDER_STYLES.classic;
}

/**
 * Resolve the text color for a style: '#ffffff' (the column default) means
 * "keep the template's own default" — mirrors templateTextColor in
 * captions.js (white is unreadable on light templates like highlighter).
 */
function resolveTextColor(style, textColor) {
  const def = captionStyleDef(style);
  return textColor && textColor.toLowerCase() !== "#ffffff" ? textColor : def.color;
}

/** Wrap the active word in the style's accent span. */
function accentedCueText(cue, activeIndex, def) {
  const words =
    Array.isArray(cue.words) && cue.words.length > 0
      ? cue.words.map((w) => String(w.text))
      : String(cue.text).split(/\s+/);
  return words
    .map((word, i) => {
      if (def.accent === "dim") {
        // No background spans exist, so chip-style templates dim the inactive
        // words and leave the spoken word at full strength.
        return i === activeIndex ? word : `[opacity 78]${word}[/opacity]`;
      }
      return i === activeIndex ? `[color ${def.accentColor}]${word}[/color]` : word;
    })
    .join(" ");
}

function captionElement(name, text, { start, length, style, textColor, family, stroke, shadow }) {
  const def = captionStyleDef(style);
  return {
    type: "text",
    name,
    track: CAPTION_TRACK,
    time: Math.max(0, start),
    duration: Math.max(0.08, length),
    text,
    font_family: family,
    font_size: def.fontSize,
    fill_color: resolveTextColor(style, textColor),
    ...(def.uppercase ? { text_transform: "uppercase" } : {}),
    ...(def.letterSpacingPct ? { letter_spacing: def.letterSpacingPct } : {}),
    ...(def.lineHeightPct ? { line_height: def.lineHeightPct } : {}),
    // Bottom-anchored like Shotstack's position:"bottom" + offset y:0.08 —
    // the box's bottom edge stays pinned as lines wrap and grow upward.
    x: "50%",
    y: "92%",
    y_anchor: "100%",
    width: "90%",
    x_alignment: "50%",
    ...(def.background
      ? {
          background_color: def.background,
          background_x_padding: def.backgroundXPct,
          background_y_padding: def.backgroundYPct,
          background_border_radius: def.radiusPct,
        }
      : {}),
    ...(stroke
      ? { stroke_color: stroke.color, stroke_width: stroke.size }
      : {}),
    ...(shadow
      ? {
          shadow_color: shadow.color,
          shadow_x: 0,
          shadow_y: Math.round(shadow.size * 0.6),
          shadow_blur: Math.round(shadow.size * 2),
        }
      : {}),
  };
}

/**
 * Build the Creatomate RenderScript. Same input contract as shotstack.js's
 * buildEditJson so the render pipeline is provider-agnostic.
 */
export function buildRenderSpec({
  sourceVideoUrl,
  sourceTrimSeconds = 0,
  durationSeconds,
  watermarkUrl,
  brollClips = [],
  musicTrack = null,
  captionCues = [],
  captionFontKey = "anton",
  captionStyle = "classic",
  captionTextColor = "#ffffff",
  captionStroke = false,
  captionShadow = false,
  captionStrokeColor = "#000000",
  captionStrokeSize = 4,
  captionShadowColor = "#000000",
  captionShadowSize = 6,
}) {
  const font = captionFont(captionFontKey);
  const def = captionStyleDef(captionStyle);

  const elements = [];

  // Track 1 — main talking-head video. "cover" crops the landscape source
  // into the 9:16 canvas (equivalent of Shotstack fit:"crop"); the explicit
  // duration drives the composition length.
  elements.push({
    type: "video",
    name: "Video-1",
    track: 1,
    time: 0,
    duration: durationSeconds,
    source: sourceVideoUrl,
    trim_start: Math.max(0, sourceTrimSeconds),
    trim_duration: durationSeconds,
    fit: "cover",
  });

  // Track 2 — b-roll cutaways over the main video (muted, fade in/out).
  for (const [i, b] of brollClips.slice(0, 6).entries()) {
    const start = Math.max(0, Number(b.start));
    // Trim the last b-roll so it can't overrun the clip.
    const length = Math.min(Number(b.end) - Number(b.start), durationSeconds - start);
    if (length <= 0) continue;
    const fade = Math.min(0.4, length / 2);
    elements.push({
      type: "video",
      name: `Broll-${i + 1}`,
      track: 2,
      time: start,
      duration: length,
      source: b.src,
      fit: "cover",
      volume: "0%",
      animations: [
        { type: "fade", time: 0, duration: fade },
        { type: "fade", time: "end", duration: fade, reversed: true },
      ],
    });
  }

  // Track 3 — optional logo watermark (top-right, same geometry as Shotstack).
  if (watermarkUrl) {
    elements.push({
      type: "image",
      name: "Watermark-1",
      track: 3,
      time: 0,
      duration: durationSeconds,
      source: watermarkUrl,
      fit: "contain",
      width: "14%",
      x: "91%",
      y: "7%",
      opacity: "90%",
    });
  }

  // Track 4 — captions. Cues with word timings render one element per spoken
  // word with the active word accented (word-sync highlight); cues without
  // timings render as one static element each.
  if (captionCues.length > 0) {
    const stroke = captionStroke
      ? { color: captionStrokeColor || "#000000", size: captionStrokeSize }
      : null;
    const shadow = captionShadow
      ? { color: captionShadowColor || "#000000", size: captionShadowSize }
      : null;

    const usableCues = captionCues.slice(0, MAX_WORD_ELEMENTS);
    const wordTotal = usableCues.reduce(
      (sum, cue) => sum + (Array.isArray(cue.words) ? cue.words.length : 0),
      0
    );
    const wordSync = wordTotal > 0 && wordTotal <= MAX_WORD_ELEMENTS;

    let n = 0;
    for (const cue of usableCues) {
      if (!wordSync || !Array.isArray(cue.words) || cue.words.length === 0) {
        n += 1;
        elements.push(
          captionElement(`Caption-${n}`, String(cue.text), {
            start: Number(cue.start) || 0,
            length: Number(cue.end) - Number(cue.start),
            style: captionStyle,
            textColor: captionTextColor,
            family: font.family,
            stroke,
            shadow,
          })
        );
        continue;
      }
      for (let i = 0; i < cue.words.length; i++) {
        const w = cue.words[i];
        const start = Math.max(0, Number(w.start) || 0);
        const end = Math.max(start + 0.08, Math.min(Number(w.end) || start + 0.2, Number(cue.end)));
        n += 1;
        elements.push(
          captionElement(`Caption-${n}`, accentedCueText(cue, i, def), {
            start,
            length: end - start,
            style: captionStyle,
            textColor: captionTextColor,
            family: font.family,
            stroke,
            shadow,
          })
        );
      }
    }
  }

  // Background music at ~15% of voiceover level; duration null + loop makes
  // it follow the whole video (per the timing rules for music beds).
  if (musicTrack?.url) {
    elements.push({
      type: "audio",
      name: "Music-1",
      track: 5,
      time: 0,
      duration: null,
      loop: true,
      source: musicTrack.url,
      volume: "15%",
    });
  }

  return {
    output_format: "mp4",
    width: 1080,
    height: 1920,
    frame_rate: 30,
    fill_color: "#000000",
    fonts: [{ family: font.family, weight: 400, style: "normal", source: font.src }],
    elements,
  };
}

/**
 * Render outputs may only be pulled from Creatomate-controlled hosts.
 * Used on every URL before the worker downloads a render (the webhook path
 * delivers this URL in a request body, so it must never be trusted blindly).
 */
export function assertTrustedRenderUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error("Creatomate render URL is malformed");
  }
  if (parsed.protocol !== "https:" || !/(^|\.)creatomate\.com$/i.test(parsed.hostname)) {
    throw new Error(`Refusing to download render from untrusted host: ${parsed.hostname}`);
  }
  return parsed.toString();
}

export async function submitRender(renderSpec, webhookUrl) {
  if (!env.creatomateApiKey) throw new Error("CREATOMATE_API_KEY is not configured");

  // Render options (webhook_url) ride at the payload root beside the
  // RenderScript properties.
  const body = webhookUrl ? { ...renderSpec, webhook_url: webhookUrl } : renderSpec;

  const res = await fetch(`${API_BASE}/renders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.creatomateApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // Errors carry a human "hint" explaining exactly what to fix.
    throw new Error(`Creatomate render submit failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }

  const data = await res.json();
  // 202 responses may include advisory errors/warnings arrays — errors
  // predict a failing render, warnings flag ignored parts.
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(`Creatomate rejected the render: ${data.errors.join("; ")}`);
  }
  if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
    console.warn(`[creatomate] render warnings: ${data.warnings.join("; ")}`);
  }
  const renderId = data?.id;
  if (!renderId || !RENDER_ID_RE.test(String(renderId))) {
    throw new Error("Creatomate did not return a valid render id");
  }
  return String(renderId);
}

/**
 * Poll a render's status. Primary completion path is the webhook (backend
 * /webhooks/render → finalize), but the worker's watchdog polls as a
 * fallback so a webhook that never arrives can't strand a finished render.
 * Statuses are normalized to done | failed | rendering.
 */
export async function getRender(renderId) {
  if (!env.creatomateApiKey) throw new Error("CREATOMATE_API_KEY is not configured");
  if (!RENDER_ID_RE.test(String(renderId))) throw new Error("Invalid render id");

  const res = await fetch(`${API_BASE}/renders/${encodeURIComponent(renderId)}`, {
    headers: { Authorization: `Bearer ${env.creatomateApiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Creatomate render poll failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const r = await res.json();
  const rawStatus = String(r.status ?? "").toLowerCase();
  const status = rawStatus === "succeeded" ? "done" : FAILED_STATUSES.has(rawStatus) ? "failed" : "rendering";
  return {
    status,
    url: typeof r.url === "string" ? r.url : null,
    error: r.error_message ?? null,
  };
}

/**
 * Download a finished render from Creatomate's CDN to a local path.
 * The URL is host-allowlisted — webhook-provided URLs are never trusted.
 */
export async function downloadRenderedClip(url, filePath) {
  const trusted = assertTrustedRenderUrl(url);
  const res = await fetch(trusted, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`Failed to download rendered clip (${res.status})`);
  const { writeFile } = await import("node:fs/promises");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body), (await import("node:fs")).createWriteStream(filePath));
  return filePath;
}
