import { RENDER_STYLES, captionFont, resolveCaptionFontSize } from "./captions.js";
import { aspectDimensions } from "./canvas.js";
import { ensureTmpDir, tmpPath, TMP_DIR, runFfmpeg, cleanup, downloadToFile } from "./ffmpeg.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

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

// Remote https inputs get reconnect flags: a single dropped HTTP range read
// (or a resolver blip mid-encode) otherwise sinks a render that streams a
// long source for its whole duration. Same pattern extractRawPcm already
// uses for the transcription extraction.
const REMOTE_INPUT_FLAGS = [
  "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
];

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

function styleDef(style) {
  return RENDER_STYLES[style] ?? RENDER_STYLES.classic;
}

/**
 * Build the ASS subtitle file content. Cues with word timings produce one
 * dialogue event per spoken word (the event runs until the next word starts,
 * so there are no gap flashes); cues without timings produce one event each.
 * Color parity with the editor preview: active word = #ff5d1c, every other
 * word = the user's caption color at FULL opacity — no dimming, no
 * template-color substitution.
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
  captionWordSpacing = 0,
  captionLetterSpacing = 0,
  width = 1080,
  height = 1920,
}) {
  const font = captionFont(captionFontKey);
  const def = styleDef(captionStyle);
  // Literal user color — the preview renders textColor as-is, so the render
  // must too (the old white→style-color swap made "white" captions render
  // gray/off-white on several template styles).
  const primary = assColor(captionTextColor || "#ffffff");
  // The preview highlights the active word with a fixed accent — mirror it.
  const accentColor = assColor("#ff5d1c");

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
  const alignment = captionPosition === "top" ? 8 : captionPosition === "middle" ? 5 : 2;
  const marginV =
    captionPosition === "middle" ? 0 : Math.round(height * 0.08);

  // Clip-level letter spacing (% of font size) stacks on the style's own
  // spacing; 0 keeps the style default. Word spacing = extra literal spaces
  // between words — the only word-gap mechanism ASS supports, and the
  // preview renders the SAME repeated spaces, so both stay identical.
  const fspPx = Math.round(
    (((parseFloat(def.letterSpacingPct) || 0) + (Number(captionLetterSpacing) || 0)) / 100) *
      fontSize *
      10
  ) / 10;
  const fspTag = fspPx !== 0 ? `{\\fsp${fspPx}}` : "";
  const wordGap = " ".repeat(1 + Math.max(0, Math.min(5, Math.round(Number(captionWordSpacing) || 0))));
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
      pushEvent(start, end, words.join(wordGap));
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
        .map((word, j) =>
          j === i ? `{\\c${accentColor}}${word}{\\c${primary}}` : word
        )
        .join(wordGap);
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
function buildFilterGraph({
  broll,
  durationSeconds,
  width,
  height,
  assFile,
  watermarkInput = null,
  videoFit = "cover",
  videoBackgroundBlur = true,
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
    captionWordSpacing = 0,
    captionLetterSpacing = 0,
    outputAspect = "9:16",
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
      captionPosition,
      captionSize,
      captionWordSpacing,
      captionLetterSpacing,
      width,
      height,
    }),
    "utf8"
  );

  const broll = (Array.isArray(brollClips) ? brollClips : [])
    .filter((b) => Number(b.end) > Number(b.start))
    .slice(0, 6);

  // -ss before -i is frame-accurate here because the output is re-encoded.
  const inputs = ["-ss", fmt(sourceTrimSeconds), ...REMOTE_INPUT_FLAGS, "-i", String(sourceVideoUrl)];
// -ss before -i is frame-accurate here (output is re-encoded) and stops the
// overlay queue from buffering the b-roll from t=0.
for (const b of broll) inputs.push("-ss", fmt(Math.max(0, Number(b.start))), ...REMOTE_INPUT_FLAGS, "-i", String(b.src));

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
    "-filter_threads", "1",
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
    // Lookahead frames are the encoder's biggest RAM consumer at 1080x1920
    // (~25 MB per frame): 20 → 10 measured 524 → 425 MB peak RSS with no
    // visible quality change at CRF 18. The platform OOM-kills the whole pod
    // mid-encode — long before the in-code SIGKILL fallback can fire — so the
    // FIRST attempt has to fit the container. Override with RENDER_LOOKAHEAD.
    "-x264-params", `rc-lookahead=${Number(process.env.RENDER_LOOKAHEAD) || 10}:sync-lookahead=0`,
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

// The container's resolver can fail in windows — ffmpeg then dies opening
// the R2 input ("Failed to resolve hostname … System error") before reading
// a single frame, while every SDK call keeps working because it rides warm
// pooled connections. ffmpeg needs a fresh DNS lookup per render, so only
// it sees the blip. Retry the attempt with backoff: cheap once the resolver
// recovers, fast-fatal when it stays down (the job runner keeps its own
// retries on top).
const NET_OPEN_ERR_RE = /Failed to resolve hostname|Input\/output error/i;
async function withNetRetry(run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 3 || !NET_OPEN_ERR_RE.test(String(err?.message))) throw err;
      console.warn(
        `[local-render] input open failed (resolver blip?) — retrying ${attempt + 1}/3 in ${attempt * 15}s`
      );
      await new Promise((r) => setTimeout(r, attempt * 15000));
    }
  }
}

// ffmpeg's DNS resolution fails deterministically in this container — the
// static ffmpeg binary's resolver cannot look up ANY hostname (musl-based
// Node resolves the same hosts fine the whole time, which is why every SDK
// call keeps working). Retrying can't fix that, so ffmpeg must never resolve
// a hostname at all: this loopback proxy fetches the real URLs with Node and
// pipes the bytes straight through, and every remote input in the spec is
// rewritten to a http://127.0.0.1 URL before ffmpeg sees it. Range requests
// are forwarded, so -ss input seeking still lands on exact offsets. Nothing
// is buffered to disk — memory stays flat regardless of source size.
const PROXY_TOKEN = crypto.randomBytes(16).toString("hex");

function startLocalProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        const target = u.searchParams.get("u");
        if (u.pathname !== "/media" || u.searchParams.get("t") !== PROXY_TOKEN) {
          res.writeHead(403).end();
          return;
        }
        if (!/^https:\/\//i.test(target ?? "")) {
          res.writeHead(400).end();
          return;
        }
        // Forward only the range header — it is all ffmpeg sends for seeks —
        // and ask for an uncompressed body so the piped bytes and the
        // forwarded content-length always agree (fetch decompresses gzip
        // transparently, which would otherwise truncate the response).
        const headers = { "accept-encoding": "identity" };
        if (req.headers.range) headers.range = req.headers.range;
        const upstream = await fetch(target, { headers, redirect: "follow" });
        const out = {};
        for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          const v = upstream.headers.get(h);
          if (v != null) out[h] = v;
        }
        if (upstream.headers.has("content-encoding")) delete out["content-length"];
        res.writeHead(upstream.status, out);
        if (upstream.body) {
          const stream = Readable.fromWeb(upstream.body);
          // If ffmpeg dies (OOM kill, timeout) the socket closes — abort the
          // upstream download too instead of pulling the rest into the void.
          res.on("close", () => stream.destroy());
          stream.pipe(res);
        } else {
          res.end();
        }
      } catch (err) {
        console.warn(`[local-render] proxy fetch failed: ${err?.message ?? err}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Rewrite every remote media URL in the spec to a localhost proxy URL. */
function proxiedSpec(spec, proxy) {
  const port = proxy.address().port;
  const toLocal = (url) => {
    const raw = String(url ?? "");
    if (!/^https:\/\//i.test(raw)) return raw;
    return `http://127.0.0.1:${port}/media?t=${PROXY_TOKEN}&u=${encodeURIComponent(raw)}`;
  };
  return {
    ...spec,
    sourceVideoUrl: toLocal(spec.sourceVideoUrl),
    brollClips: (Array.isArray(spec.brollClips) ? spec.brollClips : []).map((b) => ({
      ...b,
      src: toLocal(b.src),
    })),
    musicTrack: spec.musicTrack?.url
      ? { ...spec.musicTrack, url: toLocal(spec.musicTrack.url) }
      : spec.musicTrack,
  };
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

  const proxy = await startLocalProxy();
  try {
    const localSpec = proxiedSpec(spec, proxy);
    // Crash-loop visibility: when the platform kills the whole pod mid-encode
    // there is no error anywhere in the logs, so heartbeat the encode — the
    // last line before a restart shows how far it got and what Node held.
    const startedAt = Date.now();
    const beat = setInterval(() => {
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      console.log(`[local-render] encoding ${Math.round((Date.now() - startedAt) / 1000)}s — node RSS ${rss} MB`);
    }, 15000);
    try {
      await withNetRetry(() => renderOnce(localSpec, outputRel, { width: 1080, height: 1920, withMusic: true }));
    } catch (err) {
      if (/SIGKILL/i.test(err.message)) {
        console.warn("[local-render] OOM-killed — retrying at half resolution with a lighter encode");
        await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
        await renderOnce(localSpec, outputRel, { width: retryWidth, height: retryHeight, withMusic: true });
      } else if (spec.musicTrack?.url && /amix|0:a|Stream map/i.test(err.message)) {
        console.warn("[local-render] audio mix failed (source may have no audio track) — retrying without music");
        await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
        await renderOnce(localSpec, outputRel, { width, height, withMusic: false });
      } else {
        throw err;
      }
    } finally {
      clearInterval(beat);
    }
  } finally {
    proxy.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
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
