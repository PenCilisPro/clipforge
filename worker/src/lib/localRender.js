import { RENDER_STYLES, captionFont } from "./captions.js";
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
 * Visual parity with the cloud providers: 1080x1920 center-crop of the source,
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

  const fspPx = def.letterSpacingPct
    ? Math.round((parseFloat(def.letterSpacingPct) / 100) * def.fontSize * 10) / 10
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
    // Alignment 2 = bottom-center; MarginV pins the box 8% above the bottom,
    // matching the cloud providers' y:92% bottom anchor.
    `Style: Cap,${font.family},${def.fontSize},${primary},&H000000FF,${strokeOn ? outlineColor : "&H00000000"},${backColour},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,60,60,${Math.round(height * 0.08)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const lines = [];
  const usableCues = (Array.isArray(captionCues) ? captionCues : []).slice(0, 400);
  const wordTotal = usableCues.reduce(
    (sum, cue) => sum + (Array.isArray(cue.words) ? cue.words.length : 0),
    0
  );
  const wordSync = wordTotal > 0 && wordTotal <= 400;

  const wordsOf = (cue) =>
    Array.isArray(cue.words) && cue.words.length > 0
      ? cue.words.map((w) => assText(w.text))
      : assText(cue.text).split(/\s+/).filter(Boolean);

  const pushEvent = (start, end, body) => {
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${blurTag}${fspTag}${body}`);
  };

  for (const cue of usableCues) {
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

  return [...header, ...lines, ""].join("\n");
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
function buildFilterGraph({ broll, durationSeconds, width, height, assFile, watermarkInput = null }) {
  const parts = [];
  parts.push(
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[base]`
  );
  let prev = "base";
  broll.forEach((b, i) => {
    const start = Math.max(0, Number(b.start));
    const len = Math.min(Number(b.end) - Number(b.start), durationSeconds - start);
    if (len <= 0) return;
    const fade = Math.min(0.4, len / 2);
    parts.push(
      `[${i + 1}:v]trim=duration=${fmt(len)},setpts=PTS+${fmt(start)}/TB,` +
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
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
  } = spec;

  await ensureFont(captionFontKey);
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
  for (const b of broll) inputs.push("-i", String(b.src));

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
  const graph = buildFilterGraph({ broll, durationSeconds, width, height, assFile: assRel, watermarkInput });
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
    "-threads", String(RENDER_THREADS),
    "-filter_threads", String(RENDER_THREADS),
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
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
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

  try {
    await renderOnce(spec, outputRel, { width: 1080, height: 1920, withMusic: true });
  } catch (err) {
    if (/SIGKILL|out of memory/i.test(err.message)) {
      console.warn("[local-render] OOM-killed — retrying at 720x1280 with a lighter encode");
      await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
      await renderOnce(spec, outputRel, { width: 720, height: 1280, withMusic: true });
    } else if (spec.musicTrack?.url && /amix|0:a|Stream map/i.test(err.message)) {
      console.warn("[local-render] audio mix failed (source may have no audio track) — retrying without music");
      await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
      await renderOnce(spec, outputRel, { width: 1080, height: 1920, withMusic: false });
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
