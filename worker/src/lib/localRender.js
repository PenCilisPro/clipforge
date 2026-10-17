import {
  RENDER_STYLES,
  CAPTION_FONTS,
  captionFont,
  resolveCaptionFontSize,
} from "./captions.js";
import { aspectDimensions } from "./canvas.js";
import { ensureTmpDir, tmpPath, TMP_DIR, runFfmpeg, cleanup, downloadToFile } from "./ffmpeg.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Local render provider — ffmpeg runs on the worker itself.
 *
 * No per-render credits, no usage limits, no watermark: the machine's own CPU
 * is the only cost. The trade-off is that encoding time scales with clip
 * length, so this is the right default for self-hosted deployments and the
 * wrong one for tiny cloud containers (set RENDER_PROVIDER=creatomate there).
 *
 * Provider contract: buildRenderSpec returns the params unchanged; submitRender
 * performs the whole render inline (there is no job to poll and no webhook —
 * the render pipeline finalizes immediately after submit returns); getRender
 * and downloadRenderedClip exist so recovery.js and finalize.js treat local
 * clips like any other provider's.
 *
 * Visual parity with the cloud providers: 1080x1920 output, either a
 * center-crop of the source (videoFit "cover") or the full frame letterboxed
 * over a blurred zoomed copy of itself (videoFit "contain"),
 * caption cues as ASS subtitles with word-sync accenting (one dialogue event
 * per spoken word, the active word recolored — same scheme as the Creatomate
 * text elements), b-roll cutaways full-screen with fades, music bed at 15%,
 * and the optional logo watermark.
 */

const RENDER_ID_RE = /^[A-Za-z0-9-]+$/;

// Caption fonts come from a fixed set of CDNs — anything else is refused
// before the worker fetches it.
const FONT_HOST_RE = /(^|\.)((cdn\.jsdelivr\.net)|(fonts\.gstatic\.com))$/i;

const RENDER_THREADS = Math.max(1, Number(process.env.RENDER_THREADS) || 1);

// Encode quality for the local provider. "fast" + CRF 18 is a clear sharpness
// upgrade over the old veryfast/20 while staying within the 40-min job
// ceiling on the constrained container (single-threaded, ~1.5-2x encode time).
// Beefier workers can push RENDER_PRESET=medium|slow and RENDER_CRF=16.
const X264_PRESETS = new Set([
  "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow",
]);
const requestedPreset = String(process.env.RENDER_PRESET ?? "").toLowerCase();
const RENDER_PRESET = X264_PRESETS.has(requestedPreset) ? requestedPreset : "fast";
const RENDER_CRF = Math.min(30, Math.max(12, Number(process.env.RENDER_CRF) || 18));
const RENDER_AUDIO_BITRATE = String(process.env.RENDER_AUDIO_BITRATE ?? "").trim() || "192k";

/** "#rrggbb" / "rgba(...)" → ASS &HAABBGGRR (alpha 00 = opaque, FF = clear). */
function assColor(value) {
  const raw = String(value).trim();
  let r = 255, g = 255, b = 255, a = 1;
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  const rgba = raw.match(/rgba?\(([^)]+)\)/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else if (rgba) {
    const parts = rgba[1].split(",").map((p) => parseFloat(p));
    r = parts[0] ?? 255;
    g = parts[1] ?? 255;
    b = parts[2] ?? 255;
    a = parts.length > 3 ? parts[3] : 1;
  }
  const hx = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();
  return `&H${hx((1 - a) * 255)}${hx(b)}${hx(g)}${hx(r)}`;
}

/** Seconds → ASS timestamp H:MM:SS.cc. */
function assTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100) % 100;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(sec)}.${pad(cs)}`;
}

function assText(text) {
  return String(text).replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
}

/** Clamp to [lo, hi] with a numeric fallback for junk values. */
function clampNum(value, lo, hi, fallback = 0) {
  const n = Number(value);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : fallback));
}

function styleDef(style) {
  return RENDER_STYLES[style] ?? RENDER_STYLES.classic;
}

/** Resolve text color — mirrors resolveTextColor in creatomate.js. */
function resolveTextColor(style, textColor) {
  const def = styleDef(style);
  return textColor && textColor.toLowerCase() !== "#ffffff" ? textColor : def.color;
}

/**
 * Build the ASS subtitle file content. Cues with word timings produce one
 * dialogue event per spoken word (the event runs until the next word starts,
 * so there are no gap flashes); cues without timings produce one event each.
 */
export function buildAssSubtitles({
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
  captionPosition = "bottom",
  captionSize = 0,
  captionX = null,
  captionY = null,
  captionWords = 0,
  captionWidth = 0,
  textOverlays = [],
  durationSeconds = 0,
  width = 1080,
  height = 1920,
}) {
  const font = captionFont(captionFontKey);
  const def = styleDef(captionStyle);
  const primary = assColor(resolveTextColor(captionStyle, captionTextColor));
  const accentColor = assColor(def.accentColor ?? "#ffffff");
  const dimTag = "{\\1a&H38&}"; // ~78% opacity on the text only

  const strokeOn = captionStroke === true;
  const shadowOn = captionShadow === true;
  const outlineColor = assColor(captionStrokeColor || "#000000");
  const shadowColor = assColor(captionShadowColor || "#000000");

  // Box styles render via BorderStyle 3 (opaque box in BackColour); text-only
  // styles get an outline/shadow instead, with a soft classic-style shadow
  // baked in for readability on bright footage.
  const boxed = Boolean(def.background);
  const borderStyle = boxed ? 3 : 1;
  const outline = boxed ? 0 : strokeOn ? Math.min(Number(captionStrokeSize) || 4, 10) : 0;
  const shadow = boxed ? 0 : shadowOn ? Math.min(Number(captionShadowSize) || 6, 12) : 3;
  const backColour = boxed ? assColor(def.background) : shadowColor;

  // Caption placement: ASS alignment numpad — 2 bottom-center, 5 mid-center,
  // 8 top-center. MarginV pins the block 8% inside the top/bottom edge
  // (matching the cloud providers' 8% offset); centered captions use 0.
  const fontSize = resolveCaptionFontSize(captionStyle, captionSize);
  // Free-drag caption position (percent of canvas) overrides the preset
  // placement: alignment 5 (middle center) anchors the block on \pos(x, y),
  // so a saved caption_x/caption_y renders pixel-for-pixel like the preview.
  const freePos =
    captionX != null && captionY != null
      ? `{\\pos(${Math.round(width * (clampNum(captionX, 0, 100) / 100))},${Math.round(
          height * (clampNum(captionY, 0, 100) / 100)
        )})}`
      : "";
  const alignment = freePos
    ? 5
    : captionPosition === "top"
      ? 8
      : captionPosition === "middle"
        ? 5
        : 2;
  const marginV = freePos
    ? 0
    : captionPosition === "middle"
      ? 0
      : Math.round(height * 0.08);

  // Caption wrap width (% of canvas) — per-event MarginL/R override the style
  // margins so lines wrap at the same width as the preview's caption box.
  const capWrapPct = Number(captionWidth) > 0 ? clampNum(captionWidth, 20, 100, 90) : 0;
  const capMarginLR = capWrapPct > 0 ? Math.round((width * (100 - capWrapPct)) / 200) : 0;

  const fspPx = def.letterSpacingPct
    ? Math.round((parseFloat(def.letterSpacingPct) / 100) * fontSize * 10) / 10
    : 0;
  const fspTag = fspPx > 0 ? `{\\fsp${fspPx}}` : "";
  const blurTag = shadowOn || strokeOn ? "{\\blur2}" : "";

  const header = [
    "[Script Info]",
    "; Generated by the ClipForge local render provider",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment (2 bottom / 5 middle / 8 top, all center) + MarginV pin the
    // block inside the edge, matching the cloud providers' placement.
    `Style: Cap,${font.family},${fontSize},${primary},&H000000FF,${strokeOn ? outlineColor : "&H00000000"},${backColour},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},60,60,${marginV},1`,
  ];

  // Custom text overlays: one style + one full-duration \pos event each, on
  // layer 1 so they paint above the captions. BorderStyle 3 paints the
  // optional dark box (OutlineColour doubles as the box fill at ~71%
  // opacity); unboxed text gets a soft drop shadow instead.
  const ovStyles = [];
  const ovEvents = [];
  const ovList = (Array.isArray(textOverlays) ? textOverlays : [])
    .filter((o) => o && String(o.text ?? "").trim().length > 0)
    .slice(0, 10);
  ovList.forEach((o, i) => {
    const fontKey =
      o.font && Object.prototype.hasOwnProperty.call(CAPTION_FONTS, o.font) ? o.font : "poppins";
    const fs = Math.max(10, Math.round((height * clampNum(o.size, 1, 30, 5)) / 100));
    const color = assColor(/^#[0-9a-fA-F]{6}$/.test(String(o.color)) ? o.color : "#ffffff");
    const boxed = o.bg === true;
    const ox = Math.round(width * (clampNum(o.x, 0, 100, 50) / 100));
    const oy = Math.round(height * (clampNum(o.y, 0, 100, 50) / 100));
    // Wrap width (% of canvas): per-event margins so multi-line overlay text
    // wraps at the same width as the editor preview box.
    const ovML = Math.round((width * (100 - clampNum(o.width, 20, 100, 90))) / 200);
    ovStyles.push(
      `Style: Ov${i},${captionFont(fontKey).family},${fs},${color},&H000000FF,` +
        `${boxed ? "&H4A000000" : "&H00000000"},&H00000000,${o.bold === false ? 0 : -1},` +
        `0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? 8 : 0},${boxed ? 0 : 2},5,40,40,0,1`
    );
    const body =
      String(o.text)
        .split(/\r?\n/)
        .map((line) => assText(line))
        .filter(Boolean)
        .slice(0, 4)
        .join("\\N") || "Text";
    ovEvents.push(
      `Dialogue: 1,${assTime(0)},${assTime(Math.max(0.1, Number(durationSeconds) || 0))},` +
        `Ov${i},,${ovML},${ovML},0,,{\\pos(${ox},${oy})}${body}`
    );
  });

  const lines = [];
  const usableCues = (Array.isArray(captionCues) ? captionCues : []).slice(0, 400);

  // "Words per screen" (caption_words): flatten every timed word and re-chunk
  // into groups of N so the render shows exactly the same words per caption
  // block as the editor preview. Cues without word timings get times spread
  // proportionally to word length. Chunk words carry both .text and .word so
  // the existing event builders keep working unchanged.
  const nWords = Math.round(Number(captionWords) || 0);
  let grouped = usableCues;
  if (nWords >= 1 && nWords <= 12 && usableCues.length > 0) {
    const flat = [];
    for (const cue of usableCues) {
      const start = Math.max(0, Number(cue.start) || 0);
      const end = Math.max(start + 0.08, Number(cue.end) || start + 1);
      const timed = Array.isArray(cue.words)
        ? cue.words
            .map((w) => {
              const word = assText((w && (w.text ?? w.word)) ?? "");
              return {
                text: word,
                word,
                start: Math.max(0, Number(w && w.start) || 0),
                end: Math.max(0, Number(w && w.end) || 0),
              };
            })
            .filter((w) => w.text.length > 0)
        : [];
      if (timed.length > 0) {
        flat.push(...timed);
      } else {
        const raw = assText(cue.text).split(/\s+/).filter(Boolean);
        const total = raw.reduce((s, w) => s + w.length, 0) || 1;
        const dur = Math.max(0.3, end - start);
        let t = start;
        for (const w of raw) {
          const d = (w.length / total) * dur;
          flat.push({ text: w, word: w, start: t, end: t + d });
          t += d;
        }
      }
    }
    if (flat.length > 0) {
      grouped = [];
      for (let i = 0; i < flat.length; i += nWords) {
        const chunk = flat.slice(i, i + nWords);
        grouped.push({
          start: chunk[0].start,
          end: chunk[chunk.length - 1].end,
          text: chunk.map((w) => w.text).join(" "),
          words: chunk,
        });
      }
    }
  }

  const wordTotal = grouped.reduce(
    (sum, cue) => sum + (Array.isArray(cue.words) ? cue.words.length : 0),
    0
  );
  const wordSync = wordTotal > 0 && wordTotal <= 400;

  const wordsOf = (cue) =>
    Array.isArray(cue.words) && cue.words.length > 0
      ? cue.words.map((w) => assText(w.text))
      : assText(cue.text).split(/\s+/).filter(Boolean);

  const pushEvent = (start, end, body) => {
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,${capMarginLR},${capMarginLR},0,,${freePos}${blurTag}${fspTag}${body}`);
  };

  for (const cue of grouped) {
    if (!wordSync || !Array.isArray(cue.words) || cue.words.length === 0) {
      // Static cue: one event spanning the whole cue.
      const start = Math.max(0, Number(cue.start) || 0);
      const end = Math.max(start + 0.08, Number(cue.end) || start + 1);
      const words = wordsOf(cue).map((w) => (def.uppercase ? w.toUpperCase() : w));
      pushEvent(start, end, words.join(" "));
      continue;
    }
    const cueEnd = Math.max(Number(cue.start) || 0, Number(cue.end) || 0);
    for (let i = 0; i < cue.words.length; i++) {
      const w = cue.words[i];
      const start = Math.max(0, Number(w.start) || 0);
      const nextStart = i < cue.words.length - 1 ? Number(cue.words[i + 1].start) : null;
      // Each event holds until the next word begins, so the caption never
      // flashes off between words.
      const end = Math.min(
        Math.max(start + 0.08, nextStart ?? cueEnd),
        Math.max(cueEnd, start + 0.08)
      );
      const words = wordsOf(cue).map((word) => (def.uppercase ? word.toUpperCase() : word));
      const body = words
        .map((word, j) => {
          if (def.accent === "dim") {
            return j === i ? word : `${dimTag}${word}{\\1a&H00&}`;
          }
          return j === i ? `{\\c${accentColor}}${word}{\\c${primary}}` : word;
        })
        .join(" ");
      pushEvent(start, end, body);
    }
  }

  return [
    ...header,
    ...ovStyles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    ...ovEvents,
    "",
  ].join("\n");
}

/** Fetch the caption TTF into the shared fonts dir (cached by family). */
async function ensureFont(fontKey) {
  const font = captionFont(fontKey);
  const parsed = new URL(font.src);
  if (parsed.protocol !== "https:" || !FONT_HOST_RE.test(parsed.hostname)) {
    throw new Error(`Refusing to fetch caption font from untrusted host: ${parsed.hostname}`);
  }
  const fontsDir = path.join(TMP_DIR, "fonts");
  await fs.mkdir(fontsDir, { recursive: true });
  const dest = path.join(fontsDir, `${font.family.replace(/\s+/g, "")}.ttf`);
  try {
    await fs.access(dest);
  } catch {
    await downloadToFile(font.src, dest);
  }
  return dest;
}

async function ensureWatermark(url) {
  const parsed = new URL(String(url));
  if (parsed.protocol !== "https:" || /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|\[)/i.test(parsed.hostname)) {
    throw new Error(`Refusing to fetch watermark from untrusted host: ${parsed.hostname}`);
  }
  const dest = tmpPath(`wm-${crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 16)}.png`);
  try {
    await fs.access(dest);
  } catch {
    await downloadToFile(String(url), dest);
  }
  return dest;
}

function fmt(n) {
  return (Math.round(n * 1000) / 1000).toString();
}

/** Build the filter_complex graph (video chain; audio chain is appended). */
function buildFilterGraph({
  broll,
  durationSeconds,
  width,
  height,
  assFile,
  watermarkInput = null,
  videoFit = "cover",
  videoBackgroundBlur = true,
  videoScale = 100,
  videoX = 0,
  videoY = 0,
}) {
  const parts = [];
  // Lanczos resampling: bilinear (the default) visibly softens the 1080x1920
  // scrub, especially when upscaling smaller sources.
  if (videoFit === "contain") {
    if (videoBackgroundBlur) {
      // Zoomed + blurred (and slightly darkened) copy fills the 9:16 canvas;
      // the untouched letterboxed frame is centered on top of it.
            // Blur is computed at 1/8 resolution then upscaled: gblur sigma=24 at
      // full 1080x1920 is so slow the split's other branch queues frames
      // unboundedly and OOM-kills the container (and gblur slice-threading
      // has a known SIGSEGV). Same soft-blur look, ~50x faster, stable.
      const bw = Math.round(width / 8);
      const bh = Math.round(height / 8);
      parts.push(
        `[0:v]split=2[bgs][fgs];` +
          `[bgs]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${bw}:${bh},boxblur=luma_radius=6:luma_power=2:chroma_radius=6:chroma_power=2,` +
          `eq=brightness=-0.07,scale=${width}:${height}:flags=bilinear[bg];` +
          `[fgs]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
          `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`
      );
    } else {
      // No blur: letterbox the untouched frame on plain black bars.
      parts.push(
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[base]`
      );
    }
  } else {
    parts.push(
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1[base]`
    );
  }
  // Editor video transform: zoom the composited base frame, then pan it.
  // Overlaying the scaled frame on a black canvas handles both zoom-in
  // (overflow clips at the canvas edge) and zoom-out / pan (black shows past
  // the edges) — the same math as the editor preview's CSS translate+scale.
  const zt = Math.min(3, Math.max(0.5, (Number(videoScale) || 100) / 100));
  const panX = Math.round(width * (clampNum(videoX, -100, 100) / 100));
  const panY = Math.round(height * (clampNum(videoY, -100, 100) / 100));
  if (Math.abs(zt - 1) > 0.001 || panX !== 0 || panY !== 0) {
    const bgDur = Math.max(1, Number(durationSeconds) || 1) + 1;
    parts.push(
      `[base]scale=trunc(iw*${fmt(zt)}/2)*2:trunc(ih*${fmt(zt)}/2)*2:flags=lanczos,setsar=1[zt]`
    );
    parts.push(`color=c=black:s=${width}x${height}:r=30:d=${fmt(bgDur)}[ztbg]`);
    parts.push(
      `[ztbg][zt]overlay=x=(W-w)/2` + (panX < 0 ? "" : "+") + panX +
      `:y=(H-h)/2` + (panY < 0 ? "" : "+") + panY + `:eof_action=pass,setsar=1[base]`
    );
  }
  let prev = "base";
  broll.forEach((b, i) => {
    const start = Math.max(0, Number(b.start));
    const len = Math.min(Number(b.end) - Number(b.start), durationSeconds - start);
    if (len <= 0) return;
    const fade = Math.min(0.4, len / 2);
    parts.push(
      `[${i + 1}:v]trim=duration=${fmt(len)},setpts=PTS+${fmt(start)}/TB,` +
        `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},` +
        `format=yuva420p,fade=t=in:st=${fmt(start)}:d=${fmt(fade)}:alpha=1,` +
        `fade=t=out:st=${fmt(start + len - fade)}:d=${fmt(fade)}:alpha=1[b${i}]`
    );
    parts.push(
      `[${prev}][b${i}]overlay=0:0:enable='between(t,${fmt(start)},${fmt(start + len)})':eof_action=pass[o${i}]`
    );
    prev = `o${i}`;
  });
  if (watermarkInput != null) {
    // Top-right, 14% of frame width, ~90% opacity — mirrors the cloud specs.
    const wmWidth = Math.round(width * 0.14);
    parts.push(`[${watermarkInput}:v]scale=${wmWidth}:-1,format=rgba,colorchannelmixer=aa=0.9[wm]`);
    parts.push(`[${prev}][wm]overlay=x=main_w-overlay_w-36:y=36:enable='between(t,0,${fmt(durationSeconds)})'[owm]`);
    prev = "owm";
  }
  parts.push(`[${prev}]subtitles=${assFile}:fontsdir=fonts[vout]`);
  return parts.join(";\n");
}

async function renderOnce(spec, outputRel, { width, height, withMusic }) {
  const {
    sourceVideoUrl,
    sourceTrimSeconds = 0,
    durationSeconds,
    brollClips = [],
    musicTrack = null,
    watermarkUrl,
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
    videoFit = "cover",
    videoBackgroundBlur = true,
    captionPosition = "bottom",
    captionSize = 0,
    outputAspect = "9:16",
    captionX = null,
    captionY = null,
    captionWords = 0,
    captionWidth = 0,
    textOverlays = [],
    videoScale = 100,
    videoX = 0,
    videoY = 0,
  } = spec;

  await ensureFont(captionFontKey);
  // Overlay fonts must sit in the fonts dir before libass resolves styles.
  for (const key of new Set(
    (Array.isArray(textOverlays) ? textOverlays : [])
      .slice(0, 10)
      .map((o) => (o && typeof o.font === "string" && o.font ? o.font : "poppins"))
  )) {
    await ensureFont(key).catch(() => {});
  }
  const assRel = `captions-${path.basename(outputRel, ".mp4")}.ass`;
  await fs.writeFile(
    path.join(TMP_DIR, assRel),
    buildAssSubtitles({
      captionCues,
      captionFontKey,
      captionStyle,
      captionTextColor,
      captionStroke,
      captionShadow,
      captionStrokeColor,
      captionStrokeSize,
      captionShadowColor,
      captionShadowSize,
      captionPosition,
      captionSize,
      captionX,
      captionY,
      captionWords,
      captionWidth,
      textOverlays,
      durationSeconds,
      width,
      height,
    }),
    "utf8"
  );

  const broll = (Array.isArray(brollClips) ? brollClips : [])
    .filter((b) => Number(b.end) > Number(b.start))
    .slice(0, 6);

  // -ss before -i is frame-accurate here because the output is re-encoded.
  const inputs = ["-ss", fmt(sourceTrimSeconds), "-i", String(sourceVideoUrl)];
// -ss before -i is frame-accurate here (output is re-encoded) and stops the
// overlay queue from buffering the b-roll from t=0.
for (const b of broll) inputs.push("-ss", fmt(Math.max(0, Number(b.start))), "-i", String(b.src));

  let watermarkInput = null;
  let wmLocalPath = null;
  if (watermarkUrl) {
    wmLocalPath = await ensureWatermark(watermarkUrl);
    watermarkInput = 1 + broll.length;
    inputs.push("-i", wmLocalPath);
  }

  let musicInput = null;
  const useMusic = withMusic && musicTrack?.url;
  if (useMusic) {
    musicInput = 1 + broll.length + (watermarkInput != null ? 1 : 0);
    inputs.push("-stream_loop", "-1", "-i", String(musicTrack.url));
  }

  const graphFileRel = `graph-${path.basename(outputRel, ".mp4")}.txt`;
  const graph = buildFilterGraph({
    broll,
    durationSeconds,
    width,
    height,
    assFile: assRel,
    watermarkInput,
    videoFit,
    videoBackgroundBlur,
    videoScale,
    videoX,
    videoY,
  });
  if (useMusic) {
    // One filtergraph file holds the video chain and the audio mix together
    // (audio never goes through CLI escaping — paths stay relative to cwd).
    const audio = [
      `[0:a]volume=1.0[a0]`,
      `[${musicInput}:a]volume=0.15[am]`,
      `[a0][am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
    ].join(";\n");
    await fs.writeFile(path.join(TMP_DIR, graphFileRel), `${graph};\n${audio}`, "utf8");
  } else {
    await fs.writeFile(path.join(TMP_DIR, graphFileRel), graph, "utf8");
  }

  const args = [
   "-threads", String(Math.min(RENDER_THREADS, 4)),
    "-filter_threads", "2",
    ...inputs,
    "-t", fmt(durationSeconds),
    "-filter_complex_script", graphFileRel,
    "-map", "[vout]",
  ];
  if (useMusic) {
    args.push("-map", "[aout]");
  } else {
    args.push("-map", "0:a?");
  }
    args.push(
    "-c:v", "libx264", "-preset", RENDER_PRESET, "-crf", String(RENDER_CRF),
    "-x264-params", "rc-lookahead=20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", RENDER_AUDIO_BITRATE,
    "-movflags", "+faststart",
    outputRel
  );

  try {
    await runFfmpeg(args, { cwd: TMP_DIR });
  } finally {
    await cleanup(path.join(TMP_DIR, assRel), path.join(TMP_DIR, graphFileRel), wmLocalPath);
  }
}

export function buildRenderSpec(params) {
  return params;
}

/**
 * Render the whole clip inline. Returns the local render id; the finished MP4
 * sits at <TMP_DIR>/render-<id>.mp4 until finalize moves it into R2.
 */
export async function submitRender(spec, _webhookUrl, meta = {}) {
  const clipId = String(meta.clipId ?? "");
  if (!RENDER_ID_RE.test(clipId)) throw new Error("Local render requires a valid clipId");

  await ensureTmpDir();
  const renderId = `local-${clipId}`;
  const outputRel = `render-${renderId}.mp4`;
  await fs.rm(path.join(TMP_DIR, outputRel), { force: true });

  // Canvas dims follow the clip's output aspect; the OOM fallback re-encodes
  // at 2/3 linear scale (1080x1920 → 720x1280 historically).
  const { width, height } = aspectDimensions(spec.outputAspect);
  const retryWidth = Math.round(width / 1.5 / 2) * 2;
  const retryHeight = Math.round(height / 1.5 / 2) * 2;

  try {
    await renderOnce(spec, outputRel, { width: 1080, height: 1920, withMusic: true });
  } catch (err) {
        if (/SIGKILL/i.test(err.message)) {
      console.warn("[local-render] OOM-killed — retrying at half resolution with a lighter encode");
      await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
      await renderOnce(spec, outputRel, { width: retryWidth, height: retryHeight, withMusic: true });
    } else if (spec.musicTrack?.url && /amix|0:a|Stream map/i.test(err.message)) {
      console.warn("[local-render] audio mix failed (source may have no audio track) — retrying without music");
      await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
      await renderOnce(spec, outputRel, { width, height, withMusic: false });
    } else {
      throw err;
    }
  }
  return renderId;
}

/** Recovery path: a local clip is done iff its output file survived on disk. */
export async function getRender(renderId) {
  if (!RENDER_ID_RE.test(String(renderId))) throw new Error("Invalid render id");
  const file = path.join(TMP_DIR, `render-${renderId}.mp4`);
  try {
    await fs.access(file);
    return { status: "done", url: `local:${renderId}`, error: null };
  } catch {
    return {
      status: "failed",
      url: null,
      error: "local render output is gone (worker restarted mid-render) — retry the clip",
    };
  }
}

/**
 * "Download" the finished render: it is already on this machine, so this just
 * copies it into finalize's staging path. Idempotent — a retried finalize
 * finds the staged file from the previous attempt and reuses it.
 */
export async function downloadRenderedClip(url, filePath) {
  const raw = String(url ?? "");
  if (!raw.startsWith("local:")) {
    throw new Error(`Refusing to download render from untrusted source: ${raw.slice(0, 120)}`);
  }
  const renderId = raw.slice("local:".length);
  if (!RENDER_ID_RE.test(renderId)) throw new Error("Invalid local render id");
  const source = path.join(TMP_DIR, `render-${renderId}.mp4`);

  try {
    await fs.access(filePath);
    return filePath; // staged by an earlier attempt
  } catch {
    // not staged yet
  }
  await fs.copyFile(source, filePath);
  await fs.rm(source, { force: true }).catch(() => {});
  return filePath;
}
