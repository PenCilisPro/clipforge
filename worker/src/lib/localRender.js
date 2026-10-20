import { RENDER_STYLES, captionFont } from "./captions.js";
import { aspectDimensions } from "./canvas.js";
import { ensureTmpDir, tmpPath, TMP_DIR, runFfmpeg, cleanup, downloadToFile, probeMedia } from "./ffmpeg.js";
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
 * over a blurred zoomed copy of itself (videoFit "contain"), caption cues as
 * ASS subtitles with word-sync accenting (one dialogue event per spoken
 * word), b-roll cutaways full-screen with fades, music bed at 15%, and the
 * optional logo watermark.
 *
 * Caption parity target is the CLIP EDITOR'S LIVE PREVIEW (the overlay the
 * user drags/scales while editing) — see buildAssSubtitles for the exact
 * size/color/stroke/shadow/spacing/position/animation rules it mirrors.
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

// x264 lookahead frames. Each buffered frame costs ~10 MB of encoder RSS at
// 1080x1920, so the constrained container runs 10 (down from the x264
// default of 20 — measured ~19% less peak memory for the encode). Bigger
// boxes can raise it via RENDER_LOOKAHEAD for marginally better rate
// accuracy at scene cuts.
const RENDER_LOOKAHEAD = Math.min(40, Math.max(0, Number(process.env.RENDER_LOOKAHEAD) || 10));

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

// Editor-preview parity constants — the clip editor's live caption overlay
// (frontend/components/dashboard/clip-editor.tsx + lib/caption-anim.ts) is
// the ground truth the local render must match.
const PREVIEW_DEFAULT_FONT_SIZE = 60; // the overlay's "Auto" size on the 1080 canvas
const PREVIEW_ACCENT_COLOR = "#ff5d1c"; // fixed active-word accent
const PREVIEW_INACTIVE_WHITE = "#d9d9d9"; // inactive words when color = "template default"

// Active-word accent per BOXED template. The editor overlay draws no box, so
// its fixed orange accent always reads — but burned into a same-hue template
// box (karaoke's orange-on-orange) or a light one (highlighter's yellow) it
// disappears. Each entry mirrors that template's own accent chip from the
// template cards (caption-preview.tsx ACCENTS): white text on karaoke's
// orange slab, near-black on green-screen/highlighter, white on neon/ocean/
// bubblegum slabs, yellow on royal violet. Unboxed styles keep the overlay's
// orange verbatim. A custom text color doesn't change this — the accent must
// contrast the BOX, not the text color.
const TEMPLATE_ACCENT_COLORS = {
  karaoke: "#ffffff",
  neon: "#ffffff",
  "green-screen": "#000000",
  highlighter: "#111827",
  ocean: "#ffffff",
  bubblegum: "#ffffff",
  royal: "#fde047",
};

/**
 * Build the ASS subtitle file content. Everything mirrors the editor's live
 * caption overlay so a local render lands where the user previewed it:
 *
 *   size      — the overlay draws the slider px straight on the 1080-wide
 *               canvas and treats 0 ("Auto") as 60px. Same rule here; the
 *               old per-template defaults (56-68px) never matched preview.
 *   color     — '#ffffff' is the editor's "template default" sentinel: the
 *               overlay then draws inactive words in #d9d9d9 and the active
 *               word in the fixed accent #ff5d1c. Other colors pass through
 *               literally.
 *   stroke    — outline px = caption_stroke_size × fontSize / 256 (the
 *               overlay's WebkitTextStroke ratio), clamped to [1, 8].
 *   shadow    — offset px = caption_shadow_size × fontSize / 192 (the
 *               overlay's textShadow ratio), clamped to [1, 12]; \blur
 *               stands in for the CSS blur radius, and only then — the
 *               preview stroke is crisp, and blur would wash the 1-3px
 *               outline away.
 *   spacing   — letter spacing = slider % × fontSize (the overlay's exact
 *               formula; the old render stacked template tracking on top).
 *               Word spacing = literal extra spaces, same as the overlay.
 *   width     — the overlay wraps text at caption_width % of the canvas;
 *               MarginL/MarginR park the remaining band symmetrically.
 *   position  — top/middle/bottom presets at 8% / center, and the drag
 *               position (caption_x/caption_y, block CENTER) as \an5\pos,
 *               matching the overlay's translate(-50%,-50%) anchor.
 *   templates — boxed templates render via BorderStyle 3: libass paints the
 *               box in OutlineColour expanded by Outline px (frame-verified
 *               with ffmpeg 7.1: with Outline 0 the box degenerates to the
 *               glyph bbox and disappears — the old output silently lost
 *               every template box). Padding scales with the font. A user
 *               stroke can't coexist with the box (single Outline field), so
 *               the box wins, like the cloud providers.
 *   animation — one dialogue event per spoken word; libass applies inline
 *               \t transforms only to the text FOLLOWING the tag (verified),
 *               so the active word scales/colors inside the line exactly
 *               like the overlay's per-word CSS:
 *                 pop        → scale to 1.15 with a 130ms spring settle
 *                 bounce     → scale to 1.25 over 190ms
 *                 shake      → line wobble re-triggered on every word
 *                 fade       → 80ms color crossfade on the active word
 *                 typewriter → words after the active one stay hidden
 *                 slideUp    → line rises 200ms once per cue (\move when a
 *                              drag position exists; fade + settle otherwise,
 *                              because \move would drop the wrap margins)
 *                 none       → accent snap only
 */

/**
 * "Words per screen" (spec.captionWords) — render-side twin of the clip
 * editor's regroupCuesForDisplay: flatten every cue into timed words and
 * re-chunk into blocks of exactly N words.
 *   - cues with word timings keep them; cues without get their span spread
 *     proportionally to word length (min cue span 0.3s), same as the preview.
 *   - chunks span original cue boundaries (the preview flattens globally).
 *   - n < 1 (off) or a failed regroup returns the cues untouched.
 */
function regroupCuesByWords(cues, n) {
  const size = Math.round(Number(n) || 0);
  if (!Number.isFinite(size) || size < 1) return cues;
  const list = Array.isArray(cues) ? cues : [];
  const words = [];
  for (const c of list) {
    const raw = String(c?.text ?? "").trim().split(/\s+/).filter(Boolean);
    if (raw.length === 0) continue;
    const timed =
      Array.isArray(c.words) && c.words.length > 0
        ? c.words.map((w) => ({
            text: String(w?.text ?? w?.word ?? "").trim(),
            start: Number(w?.start) || 0,
            end: Number(w?.end) || 0,
          }))
        : [];
    if (timed.length > 0) {
      words.push(...timed);
    } else {
      const start = Math.max(0, Number(c.start) || 0);
      const dur = Math.max(0.3, (Number(c.end) || start) - start);
      const total = raw.reduce((s, w) => s + w.length, 0) || 1;
      let t = start;
      for (const w of raw) {
        const d = (w.length / total) * dur;
        words.push({ text: w, start: t, end: t + d });
        t += d;
      }
    }
  }
  const out = [];
  for (let i = 0; i < words.length; i += size) {
    const chunk = words.slice(i, i + size);
    if (chunk.length === 0) continue;
    out.push({
      id: `grp-${i}`,
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map((w) => w.text).join(" "),
      words: chunk,
    });
  }
  return out.length > 0 ? out : cues;
}

export function buildAssSubtitles({
  captionCues = [],
  // "Words per screen" regroup size (0 = off — render cues as edited).
  captionWords = 0,
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
  captionX = null,
  captionY = null,
  captionAnim = "none",
  captionWidth = 90,
  width = 1080,
  height = 1920,
  // Standalone text overlays ("+ Add text" in the clip editor). Rendered with
  // the SAME scaling/positioning/box mechanics as captions — see the overlay
  // block near the end of this function for the exact rules.
  textOverlays = [],
  durationSeconds = 0,
}) {
  const font = captionFont(captionFontKey);
  const def = styleDef(captionStyle);
  // Boxed templates (karaoke, highlighter, …) render via BorderStyle 3; the
  // flag also picks the readable per-template accent color below.
  const boxed = Boolean(def.background);

  // ---- size -----------------------------------------------------------------
  const sizeOverride = Number(captionSize);
  const fontSize =
    Number.isFinite(sizeOverride) && sizeOverride > 0
      ? Math.min(Math.round(sizeOverride), 200)
      : PREVIEW_DEFAULT_FONT_SIZE;

  // ---- colors -----------------------------------------------------------------
  const isTemplateDefaultWhite =
    String(captionTextColor ?? "#ffffff").trim().toLowerCase() === "#ffffff";
  const primaryHex = isTemplateDefaultWhite
    ? PREVIEW_INACTIVE_WHITE
    : String(captionTextColor || "#ffffff");
  const primary = assColor(primaryHex);
  const accentColor = assColor(boxed
    ? (TEMPLATE_ACCENT_COLORS[captionStyle] ?? PREVIEW_ACCENT_COLOR)
    : PREVIEW_ACCENT_COLOR);

  // ---- stroke / shadow ----------------------------------------------------------
  const strokeOn = captionStroke === true;
  const shadowOn = captionShadow === true;
  const round1 = (n) => Math.round(n * 10) / 10;
  const strokePx = strokeOn
    ? Math.min(8, Math.max(1, round1(((Number(captionStrokeSize) || 4) * fontSize) / 256)))
    : 0;
  const shadowPx = shadowOn
    ? Math.min(12, Math.max(1, round1(((Number(captionShadowSize) || 6) * fontSize) / 192)))
    : 0;

  // ---- template boxes + style line ---------------------------------------------
  const borderStyle = boxed ? 3 : 1;
  const boxPad = Math.max(6, Math.round(fontSize * 0.22));
  const outline = boxed ? boxPad : strokePx;
  const shadow = shadowOn ? shadowPx : 0;
  const outlineColour = boxed
    ? assColor(def.background)
    : strokeOn
      ? assColor(captionStrokeColor || "#000000")
      : "&H00000000";
  const backColour = assColor(captionShadowColor || "#000000");

  // ---- placement ------------------------------------------------------------
  // ASS alignment numpad — 2 bottom-center, 5 mid-center, 8 top-center.
  // MarginV pins the block 8% inside the top/bottom edge (matching the
  // editor presets: bottom 8%, top 8%, middle centered); centered captions
  // use 0. Custom drag position (editor caption_x/caption_y: % of canvas,
  // the block CENTER — the preview anchors with translate(-50%,-50%),
  // mirrored by ASS \an5). Present => overrides the preset entirely.
  // NB: Number(null) === 0, so the null check must come first — otherwise a
  // missing position silently becomes \pos(0,0) (top-left corner).
  const hasCustomPos =
    captionX != null &&
    captionY != null &&
    Number.isFinite(Number(captionX)) &&
    Number.isFinite(Number(captionY));
  const posPx = hasCustomPos
    ? {
        x: Math.round((Math.min(100, Math.max(0, Number(captionX))) / 100) * width),
        y: Math.round((Math.min(100, Math.max(0, Number(captionY))) / 100) * height),
      }
    : null;
  const alignment = hasCustomPos
    ? 5
    : captionPosition === "top"
      ? 8
      : captionPosition === "middle"
        ? 5
        : 2;
  const marginV = hasCustomPos
    ? 0
    : captionPosition === "middle"
      ? 0
      : Math.round(height * 0.08);

  // ---- wrap width -----------------------------------------------------------
  // The overlay wraps the caption at caption_width % of the canvas; ASS wrap
  // width = MarginL/MarginR, so park the remainder symmetrically. (\pos
  // events ignore margins — a drag-positioned block keeps the overlay's
  // centered max-width behavior regardless.)
  const widthPct = Math.min(100, Math.max(20, Number(captionWidth) || 90));
  const marginLR = Math.max(0, Math.round(((100 - widthPct) / 200) * width));

  // ---- typography -----------------------------------------------------------
  // Letter spacing follows the overlay exactly: slider % × fontSize. Word
  // spacing = extra literal spaces between words — the only word-gap
  // mechanism ASS supports, and the overlay renders the SAME repeated
  // spaces, so both stay identical.
  const fspPx = round1(((Number(captionLetterSpacing) || 0) / 100) * fontSize);
  const fspTag = fspPx !== 0 ? `{\\fsp${fspPx}}` : "";
  const wordGap = " ".repeat(1 + Math.max(0, Math.min(5, Math.round(Number(captionWordSpacing) || 0))));
  // Soften the drop shadow only for unboxed styles (boxed events get a hard
  // offset shadow box, which reads like the overlay's box shadow anyway).
  const blurTag = shadowOn && !boxed ? "{\\blur1.5}" : "";

  // ---- animations (editor caption_anim → per-word ASS markup) ---------------
  // Per-word karaoke color is always on (active word = accent). Motion
  // splits by template type:
  //   Unboxed (classic, minimal-mono): pop/bounce ride ON THE ACTIVE WORD
  //   via inline \t — libass scopes inline transforms to the text following
  //   the tag (frame-verified), exactly like the overlay's per-word CSS.
  //   Boxed templates: a scaled word makes libass draw a taller
  //   BorderStyle-3 box patch behind just that word (frame-verified
  //   glitch), so pop/bounce degrade to a uniform line entrance per cue —
  //   the box scales cleanly and the accent still tracks the voice word by
  //   word. Shake stays a line wobble per word for both (uniform rotation
  //   never splits the box). NB: every ASS tag below is written with a
  //   double backslash — template literals eat single ones as escapes.
  const anim = String(captionAnim ?? "none").trim().toLowerCase();
  const posTag = posPx ? `{\\an5\\pos(${posPx.x},${posPx.y})}` : "";
  const wordScaleAnim = !boxed && (anim === "pop" || anim === "bounce");

  const activeWordOpen = () => {
    if (wordScaleAnim) {
      if (anim === "pop") {
        // Overlay: scale 1.15, 120ms spring — grow slightly past the
        // target, settle back.
        return `{\\t(0,60,\\fscx119\\fscy119)\\t(60,130,\\fscx115\\fscy115)\\c${accentColor}}`;
      }
      // Overlay bounce: scale 1.25, 180ms.
      return `{\\t(0,80,\\fscx129\\fscy129)\\t(80,190,\\fscx125\\fscy125)\\c${accentColor}}`;
    }
    if (anim === "fade") {
      // Overlay: color crossfade only, 80ms — no motion.
      return `{\\t(0,80,\\c${accentColor})}`;
    }
    // shake / typewriter / slideUp / none / boxed pop-bounce: instant
    // accent; motion (if any) comes from the line-level intro below.
    return `{\\c${accentColor}}`;
  };
  // Restore the inline state after the active word so the rest of the line
  // renders in the inactive color at normal scale. Skipped when nothing
  // follows (event end or typewriter tail).
  const activeWordClose = (isLast) => {
    if (isLast) return "";
    if (wordScaleAnim) return `{\\fscx100\\fscy100\\c${primary}}`;
    return `{\\c${primary}}`;
  };

  // Shake: the overlay wobbles the active word ±2px for 300ms on every word
  // change. ASS cannot translate a single word, so the line pivots a degree
  // or so instead — same rhythm, non-strobing.
  const shakeIntro =
    "{\\t(0,70,\\frz1.4)\\t(70,140,\\frz-1.4)\\t(140,210,\\frz0.7)\\t(210,290,\\frz0)}";
  // slideUp: the overlay's container rises 14px (preview scale ≈ 2% of the
  // canvas height) with a fade over 200ms, replayed once per cue. With a
  // drag position that is a real \move; without one, \move would drop the
  // wrap margins, so it degrades to a fade + settle.
  const slideUpIntro = posPx
    ? `{\\move(${posPx.x},${Math.min(height - 2, posPx.y + Math.round(height * 0.021))},${posPx.x},${posPx.y},0,200)\\fad(200,0)}`
    : "{\\fad(180,0)\\t(0,200,\\fscy92)\\t(200,340,\\fscy100)}";
  // Boxed pop/bounce: uniform line entrance at each cue start (per-word
  // scaling would tear the template box — see above).
  const boxedEntranceIntro =
    anim === "bounce"
      ? "{\\fscx70\\fscy70\\t(0,110,\\fscx112\\fscy112)\\t(110,240,\\fscx100\\fscy100)}"
      : "{\\fscx62\\fscy62\\t(0,150,\\fscx100\\fscy100)}";
  const lineIntro = (isCueStart) => {
    if (anim === "shake") return shakeIntro;
    if (anim === "slideUp" && isCueStart) return slideUpIntro;
    if (boxed && (anim === "pop" || anim === "bounce") && isCueStart) {
      return boxedEntranceIntro;
    }
    return "";
  };

  // ---- text overlays ("+ Add text") -----------------------------------------
  // The editor's draggable standalone text blocks, drawn with the caption
  // mechanics so the export matches the preview exactly:
  //   scaling     — the size slider is px on THIS canvas, identical to the
  //                 caption Size control (the editor draws slider px × the
  //                 preview/canvas ratio; the render draws \fs = slider px).
  //   positioning — x/y are % of canvas, the block CENTER; \an5\pos mirrors
  //                 the overlay's translate(-50%,-50%) anchor — the same
  //                 construction as a drag-positioned caption.
  //   box         — the Box toggle uses the caption template box recipe:
  //                 BorderStyle 3, box colour in OutlineColour, padding =
  //                 Outline = max(6, 0.22 × fontSize) — square, like every
  //                 boxed caption template.
  //   shadow      — boxless overlays keep the editor's soft drop via the
  //                 caption shadow recipe: BackColour offset (6 × fontSize
  //                 / 192, the default shadow size) + \blur for the CSS blur.
  //   wrap        — width % of canvas → symmetric MarginL/R, same as
  //                 caption_width.
  //   layer       — Layer 1: always above the caption block (Layer 0), the
  //                 editor's stacking order (overlays render after captions).
  //   text        — ASS specials stripped per line; newlines become \N so
  //                 multi-line overlays survive. Static: one event spanning
  //                 the whole clip (the editor shows no accent animation).
  //   fonts       — same captionFont() set as captions; renderOnce fetches
  //                 every distinct overlay font into fontsdir ahead of the
  //                 burn.
  const overlayList = (Array.isArray(textOverlays) ? textOverlays : []).slice(0, 10);
  const overlayStyles = [];
  const overlayEvents = [];
  overlayList.forEach((ov, ovIdx) => {
    const text = String(ov?.text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    const ovFont = captionFont(
      typeof ov?.font === "string" && ov.font.trim() ? ov.font.trim() : "poppins"
    );
    const ovSize = Math.min(200, Math.max(20, Math.round(Number(ov?.size) || 60)));
    const ovX = Math.round((Math.min(100, Math.max(0, Number.isFinite(Number(ov?.x)) ? Number(ov?.x) : 50)) / 100) * width);
    const ovY = Math.round((Math.min(100, Math.max(0, Number.isFinite(Number(ov?.y)) ? Number(ov?.y) : 50)) / 100) * height);
    const ovWidthPct = Math.min(100, Math.max(20, Number(ov?.width) || 90));
    const ovMarginLR = Math.max(0, Math.round(((100 - ovWidthPct) / 200) * width));
    const ovBold = ov?.bold !== false;
    const ovBoxed = ov?.bg === true;
    const ovBoxPad = Math.max(6, Math.round(ovSize * 0.22));
    const ovShadowPx = Math.min(12, Math.max(1, round1((6 * ovSize) / 192)));
    overlayStyles.push(
      `Style: TO${ovIdx},${ovFont.family},${ovSize},${assColor(ov?.color || "#ffffff")},&H000000FF,` +
        `${ovBoxed ? assColor("rgba(0,0,0,0.72)") : "&H00000000"},` +
        `${ovBoxed ? "&H00000000" : assColor("rgba(0,0,0,0.8)")},` +
        `${ovBold ? 1 : 0},0,0,0,100,100,0,0,${ovBoxed ? 3 : 1},${ovBoxed ? ovBoxPad : 0},${ovBoxed ? 0 : ovShadowPx},5,${ovMarginLR},${ovMarginLR},0,1`
    );
    // Escape each line, then join with \N (ASS newline). assText strips the
    // ASS-active characters ({, }) and backslashes so pasted text can never
    // inject override tags.
    const body = text.split("\n").map((ln) => assText(ln)).join("\\N");
    overlayEvents.push(
      `Dialogue: 1,${assTime(0)},${assTime(Math.max(0.1, Number(durationSeconds) || 0))},TO${ovIdx},,0,0,0,,` +
        `${ovBoxed ? "" : "{\\blur1.5}"}{\\an5\\pos(${ovX},${ovY})}${body}`
    );
  });

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
    // BorderStyle 3 paints the template box from OutlineColour expanded by
    // Outline px (the box padding); BorderStyle 1 strokes the glyphs. The
    // BackColour drop stands in for the overlay's textShadow.
    `Style: Cap,${font.family},${fontSize},${primary},&H000000FF,${outlineColour},${backColour},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${marginLR},${marginLR},${marginV},1`,
    ...overlayStyles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const lines = [];
  // "Words per screen" regroup — mirrors the editor preview exactly (0 = off).
  const usableCues = (Array.isArray(captionCues)
    ? regroupCuesByWords(captionCues, captionWords)
    : []
  ).slice(0, 400);
  const wordTotal = usableCues.reduce(
    (sum, cue) => sum + (Array.isArray(cue.words) ? cue.words.length : 0),
    0
  );
  const wordSync = wordTotal > 0 && wordTotal <= 400;

  const wordsOf = (cue) =>
    Array.isArray(cue.words) && cue.words.length > 0
      ? cue.words.map((w) => assText(w.text))
      : assText(cue.text).split(/\s+/).filter(Boolean);

  const pushEvent = (start, end, body, intro = "") => {
    // \move already carries the full position — never emit it alongside \pos
    // (the two tags fight over the event anchor in libass).
    const positionTag = intro.includes("\\move(") ? "" : posTag;
    lines.push(
      `Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${blurTag}${fspTag}${positionTag}${intro}${body}`
    );
  };

  for (const cue of usableCues) {
    if (!wordSync || !Array.isArray(cue.words) || cue.words.length === 0) {
      // Static cue: one event spanning the whole cue. The overlay draws no
      // accent without word timings, so the render doesn't either; only the
      // slideUp intro still plays (there it is a container animation).
      const start = Math.max(0, Number(cue.start) || 0);
      const end = Math.max(start + 0.08, Number(cue.end) || start + 1);
      const words = wordsOf(cue).map((w) => (def.uppercase ? w.toUpperCase() : w));
      pushEvent(start, end, words.join(wordGap), lineIntro(true));
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
      // Typewriter keeps the overlay's reveal: words after the active one
      // stay hidden (they still occupy space in the overlay; ASS can't
      // reserve mid-line space, so the line grows — the standard equivalent).
      const visible = anim === "typewriter" ? words.slice(0, i + 1) : words;
      const body = visible
        .map((word, j) =>
          j === i
            ? `${activeWordOpen()}${word}${activeWordClose(j === visible.length - 1)}`
            : word
        )
        .join(wordGap);
      pushEvent(start, end, body, lineIntro(i === 0));
    }
  }

  // Overlays live on Layer 1 (captions on Layer 0) — libass paints higher
  // layers on top, matching the editor DOM where overlays sit above captions.
  return [...header, ...lines, ...overlayEvents, ""].join("\n");
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

/**
 * Scene cuts — filter_complex that keeps only the given ranges (times are
 * RELATIVE to the input seek point) and concat-joins them into one video.
 * This is what turns the AI's edit list (scene stitches + dead-air cuts)
 * into one clip: the boring middle is simply never decoded into the output.
 *
 * - Frame-grid snapping (1/30 s) keeps A/V drift at zero across cuts.
 * - A 12 ms audio fade at each seam stops clicks at the join.
 * - When the source has no audio stream the audio branch is omitted entirely
 *   (a filtergraph referencing [0:a] without one fails to configure).
 * - Video cuts are hard cuts — the jump is the point; only the audio is eased.
 */
function buildSegmentCutFilter(segments, { fps = 30, fade = 0.012, withAudio = true } = {}) {
  const snap = (t) => Math.max(0, Math.round(t * fps) / fps);
  const parts = [];
  const pairs = [];
  segments.forEach((seg, i) => {
    const s = snap(seg.start);
    const e = Math.max(s + 1 / fps, snap(seg.end));
    const d = e - s;
    parts.push(`[0:v]trim=start=${s.toFixed(4)}:end=${e.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`);
    if (withAudio) {
      const f = Math.min(fade, d / 4);
      parts.push(
        `[0:a]atrim=start=${s.toFixed(4)}:end=${e.toFixed(4)},asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=${f.toFixed(4)},afade=t=out:st=${(d - f).toFixed(4)}:d=${f.toFixed(4)}[a${i}]`
      );
      pairs.push(`[v${i}][a${i}]`);
    } else {
      pairs.push(`[v${i}]`);
    }
  });
  parts.push(
    withAudio
      ? `${pairs.join("")}concat=n=${segments.length}:v=1:a=1[vcut][acut]`
      : `${pairs.join("")}concat=n=${segments.length}:v=1:a=0[vcut]`
  );
  return { filter: parts.join(";"), v: "[vcut]", a: withAudio ? "[acut]" : null };
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
  // Scene cuts: the video chain starts at the concat output instead of the
  // raw input. "[0:v]" (contiguous) when there is no cut list. The value is a
  // full padded reference, so the cut path passes "[vcut]" verbatim.
  cutVideoIn = "[0:v]",
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
        `${cutVideoIn}split=2[bgs][fgs];` +
          `[bgs]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${bw}:${bh},boxblur=luma_radius=6:luma_power=2:chroma_radius=6:chroma_power=2,` +
          `eq=brightness=-0.07,scale=${width}:${height}:flags=bilinear[bg];` +
          `[fgs]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
          `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`
      );
    } else {
      // No blur: letterbox the untouched frame on plain black bars.
      parts.push(
        `${cutVideoIn}scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[base]`
      );
    }
  } else {
    parts.push(
      `${cutVideoIn}scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1[base]`
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
    // "Words per screen" regroup size (0 = off — render cues as edited).
    captionWords = 0,
    // Scene cuts: edit decision list in ABSOLUTE source seconds (from Clip
    // Intelligence). null/short = render the contiguous window (classic path).
    segments = null,
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
    captionX = null,
    captionY = null,
    captionAnim = "none",
    captionWidth = 90,
    // Standalone text overlays ("+ Add text") — rendered as ASS Layer-1
    // events with the caption mechanics (see buildAssSubtitles).
    textOverlays = [],
    outputAspect = "9:16",
  } = spec;

  await ensureFont(captionFontKey);
  // Overlay fonts may differ from the caption font — every distinct overlay
  // font must be in fontsdir before libass resolves families.
  for (const ov of Array.isArray(textOverlays) ? textOverlays.slice(0, 10) : []) {
    if (!String(ov?.text ?? "").trim()) continue;
    await ensureFont(
      typeof ov?.font === "string" && ov.font.trim() ? ov.font.trim() : "poppins"
    );
  }
  const assRel = `captions-${path.basename(outputRel, ".mp4")}.ass`;
  await fs.writeFile(
    path.join(TMP_DIR, assRel),
    buildAssSubtitles({
      captionCues,
      captionWords,
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
      captionX,
      captionY,
      captionAnim,
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

  // ---------- scene cuts ----------
  // Input-seek to the first kept range; the cut filter concat-keeps every
  // range relative to that point. Downstream (scale/crop, b-roll overlays,
  // watermark, subtitles) all run on the merged timeline unchanged — only the
  // frames the main input contributes differ. A silent source renders without
  // the audio branch; a source we cannot probe renders contiguous (today's
  // behavior) rather than risk a graph that assumes audio.
  let seekTo = Number(sourceTrimSeconds) || 0;
  let cut = null;
  if (Array.isArray(segments) && segments.length >= 2) {
    const ranges = segments
      .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .sort((a, b) => a.start - b.start);
    if (ranges.length >= 2) {
      let audioKnown = false;
      let withAudio = true;
      try {
        const { streams } = await probeMedia(String(sourceVideoUrl));
        withAudio = streams.some((s) => s.codec_type === "audio");
        audioKnown = true;
      } catch (err) {
        console.warn(
          `[local-render] source probe failed (${err?.message ?? err}) — rendering the contiguous window without scene cuts`
        );
      }
      if (audioKnown) {
        seekTo = ranges[0].start;
        cut = buildSegmentCutFilter(
          ranges.map((r) => ({ start: r.start - seekTo, end: r.end - seekTo })),
          { withAudio }
        );
      }
    }
  }

  // -ss before -i is frame-accurate here because the output is re-encoded.
  const inputs = ["-ss", fmt(seekTo), ...REMOTE_INPUT_FLAGS, "-i", String(sourceVideoUrl)];
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
    cutVideoIn: cut ? cut.v : "[0:v]",
  });
  // The cut filter (trim/atrim per range + concat) must be in the graph
  // whenever scene cuts are active — it is what produces [vcut]/[acut].
  // Chain order inside filter_complex_script is irrelevant; labels link them.
  if (useMusic) {
    // One filtergraph file holds the video chain and the audio mix together
    // (audio never goes through CLI escaping — paths stay relative to cwd).
    const audio = [
      `[${cut && cut.a ? "acut" : "0:a"}]volume=1.0[a0]`,
      `[${musicInput}:a]volume=0.15[am]`,
      `[a0][am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
    ].join(";\n");
    await fs.writeFile(
      path.join(TMP_DIR, graphFileRel),
      `${cut ? `${cut.filter};\n` : ""}${graph};\n${audio}`,
      "utf8"
    );
  } else {
    await fs.writeFile(
      path.join(TMP_DIR, graphFileRel),
      cut ? `${cut.filter};\n${graph}` : graph,
      "utf8"
    );
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
  } else if (cut) {
    // Cut path: the audio (if the source has any) comes off the concat graph.
    if (cut.a) args.push("-map", cut.a);
    else args.push("-map", "0:a?");
  } else {
    args.push("-map", "0:a?");
  }
    args.push(
    "-c:v", "libx264", "-preset", RENDER_PRESET, "-crf", String(RENDER_CRF),
    "-x264-params", `rc-lookahead=${RENDER_LOOKAHEAD},sync-lookahead=0`,
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

// ---------------------------------------------------------------- loopback
// media proxy — ffmpeg does ZERO DNS from here on. The container's resolver
// deterministically breaks for the static ffmpeg binary while Node's own
// resolution keeps working (SDK traffic rides the same resolver fine), so
// every remote input is rewritten to http://127.0.0.1:<port>/media?... — a
// numeric IP needs no lookup. The proxy's Node fetch streams the real https
// target through byte-for-byte: Range headers forwarded (so -ss input
// seeking stays frame-accurate via 206/content-range), accept-encoding
// identity (fetch would otherwise decompress gzip while the forwarded
// content-length still described the compressed size → mid-stream
// truncation), and a per-process random token so nothing else on the box
// can use it. Pure pipe, zero buffering — the ~1 GiB temp-disk budget is
// untouched.
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
          // Client gone (OOM kill, ffmpeg crash, fallback teardown): abort the
          // upstream download so no zombie transfer keeps pulling bytes.
          res.on("close", () => stream.destroy());
          // pipe() does NOT forward errors — an upstream failure mid-stream
          // would otherwise be an unhandled 'error' event and take the whole
          // worker down with it. Log and end the response instead.
          stream.on("error", (err) => {
            console.warn(`[local-render] proxy stream failed: ${err?.message ?? err}`);
            res.destroy();
          });
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

/** Rewrite every remote https input to its loopback proxy URL; local paths
 *  (fonts, watermarks) pass through untouched. */
function proxiedSpec(spec, proxy) {
  const port = proxy.address().port;
  const proxyUrl = (target) => {
    const raw = String(target ?? "");
    if (!/^https:\/\//i.test(raw)) return target;
    return `http://127.0.0.1:${port}/media?t=${PROXY_TOKEN}&u=${encodeURIComponent(raw)}`;
  };
  const out = { ...spec };
  out.sourceVideoUrl = proxyUrl(spec.sourceVideoUrl);
  if (Array.isArray(out.brollClips)) {
    out.brollClips = out.brollClips.map((b) => ({ ...b, src: proxyUrl(b.src) }));
  }
  if (out.musicTrack?.url) {
    out.musicTrack = { ...out.musicTrack, url: proxyUrl(out.musicTrack.url) };
  }
  return out;
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
  const localSpec = proxiedSpec(spec, proxy);

  // Progress heartbeat: the last line before ANY container death tells us
  // exactly how far the encode got and what Node's own footprint was —
  // without it an OOM kill or platform restart is indistinguishable from a
  // silent hang.
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    console.log(`[local-render] encoding ${seconds}s — node RSS ${rss} MB`);
  }, 15000);

  try {
    try {
      await withNetRetry(() => renderOnce(localSpec, outputRel, { width: 1080, height: 1920, withMusic: true }));
    } catch (err) {
      if (/SIGKILL/i.test(err.message)) {
        console.warn("[local-render] OOM-killed — retrying at half resolution with a lighter encode");
        await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
        await renderOnce(localSpec, outputRel, { width: retryWidth, height: retryHeight, withMusic: true });
      } else if (localSpec.musicTrack?.url && /amix|0:a|Stream map/i.test(err.message)) {
        console.warn("[local-render] audio mix failed (source may have no audio track) — retrying without music");
        await fs.rm(path.join(TMP_DIR, outputRel), { force: true });
        await renderOnce(localSpec, outputRel, { width, height, withMusic: false });
      } else {
        throw err;
      }
    }
  } finally {
    clearInterval(heartbeat);
    proxy.closeAllConnections?.();
    await new Promise((r) => proxy.close(r));
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
