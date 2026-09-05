/**
 * HTML caption rendering.
 *
 * Shotstack's native `caption` asset accepts no styling on the stage API and
 * ignores timeline fonts, and — critically — the FIRST track in the timeline
 * is the TOPMOST layer (probe-verified), so captions must sit before the
 * video track or a full-screen clip covers them.
 *
 * We therefore render each caption cue as an HTML text clip with a real font
 * file (timeline.fonts expects { src: <ttf url> } entries — CSS like
 * fonts.cdnfonts.com is ignored and falls back to a generic sans).
 *
 * Stage renderer CSS subset (probe-verified by inspecting rendered frames):
 * SUPPORTED — font-family/size/weight, color, solid + rgba backgrounds,
 * padding, border-radius, display:inline-block, text-align, text-transform,
 * letter-spacing. IGNORED — text-shadow, -webkit-text-stroke, border,
 * filter/drop-shadow, <style> blocks / keyframe animations. Template styles
 * therefore use colored text + rounded boxes only.
 *
 * Word-sync highlighting: cues that carry word timings ({words:[{text,start,
 * end}]}) render as one clip per word (≤ MAX_WORD_CLIPS per video — 250+
 * clips validated on stage), swapping which word wears the accent color.
 * Cues without timings fall back to one static clip per cue.
 */

// All URLs verified reachable; families match the fonts' internal name tables.
export const CAPTION_FONTS = {
  anton: {
    family: "Anton",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/anton/Anton-Regular.ttf",
    label: "Anton",
  },
  "bebas-neue": {
    family: "Bebas Neue",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/bebasneue/BebasNeue-Regular.ttf",
    label: "Bebas Neue",
  },
  "archivo-black": {
    family: "Archivo Black",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/archivoblack/ArchivoBlack-Regular.ttf",
    label: "Archivo Black",
  },
  poppins: {
    family: "Poppins",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/poppins/Poppins-Bold.ttf",
    label: "Poppins Bold",
  },
  bangers: {
    family: "Bangers",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/bangers/Bangers-Regular.ttf",
    label: "Bangers",
  },
  "luckiest-guy": {
    family: "Luckiest Guy",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/apache/luckiestguy/LuckiestGuy-Regular.ttf",
    label: "Luckiest Guy",
  },
  "titan-one": {
    family: "Titan One",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/titanone/TitanOne-Regular.ttf",
    label: "Titan One",
  },
  "russo-one": {
    family: "Russo One",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/russoone/RussoOne-Regular.ttf",
    label: "Russo One",
  },
  righteous: {
    family: "Righteous",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/righteous/Righteous-Regular.ttf",
    label: "Righteous",
  },
  "permanent-marker": {
    family: "Permanent Marker",
    src: "https://cdn.jsdelivr.net/gh/google/fonts@main/apache/permanentmarker/PermanentMarker-Regular.ttf",
    label: "Permanent Marker",
  },
};

export function captionFont(key) {
  return CAPTION_FONTS[key] ?? CAPTION_FONTS.anton;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Each template = container markup + the accent applied to the currently-
// spoken word. `render(family, inner)` keeps the static (no-accent) output
// byte-identical to the original templates. `underlay(family, text, color)`
// reproduces the exact same typography and padding WITHOUT the background —
// used for the stroke/shadow underlay tracks (the stage renderer ignores
// text-shadow/-webkit-text-stroke, so effects are layered clips beneath the
// caption track: verified mechanics — track order, clip offset, clip opacity).
const STYLES = {
  classic: {
    accent: "color:#ff5d1c",
    render: (family, inner) =>
      `<div style="font-family:'${family}';font-size:64px;line-height:1.15;font-weight:700;color:#ffffff;text-align:center;text-shadow:0 3px 10px rgba(0,0,0,.9),0 0 4px rgba(0,0,0,.8);padding:0 12px;">${inner}</div>`,
    underlay: (family, text, color) =>
      `<div style="font-family:'${family}';font-size:64px;line-height:1.15;font-weight:700;color:${color};text-align:center;padding:0 12px;">${text}</div>`,
  },
  karaoke: {
    accent: "background:#ffffff;color:#ff5d1c;padding:0 8px;border-radius:8px;",
    render: (family, inner) =>
      `<div style="font-family:'${family}';font-size:60px;line-height:1.15;font-weight:800;color:#ffffff;background:rgba(255,93,28,.92);padding:14px 30px;border-radius:16px;text-align:center;">${inner}</div>`,
    underlay: (family, text, color) =>
      `<div style="font-family:'${family}';font-size:60px;line-height:1.15;font-weight:800;color:${color};padding:14px 30px;text-align:center;">${text}</div>`,
  },
  "bold-pop": {
    accent: "color:#ff5d1c",
    render: (family, inner) =>
      `<div style="font-family:'${family}';font-size:68px;line-height:1.1;font-weight:900;color:#ffffff;background:rgba(0,0,0,.78);padding:16px 30px;border-radius:14px;text-transform:uppercase;letter-spacing:1px;text-align:center;">${inner}</div>`,
    underlay: (family, text, color) =>
      `<div style="font-family:'${family}';font-size:68px;line-height:1.1;font-weight:900;color:${color};padding:16px 30px;text-transform:uppercase;letter-spacing:1px;text-align:center;">${text}</div>`,
  },
  // Neon sign: light-cyan text on a dark translucent slab (glow effects are
  // ignored by the stage renderer — see capability notes above).
  neon: {
    accent: "color:#ffffff",
    render: (family, inner) =>
      `<div style="font-family:'${family}';font-size:60px;line-height:1.15;font-weight:800;color:#67e8f9;background:rgba(3,28,41,.85);padding:14px 30px;border-radius:16px;letter-spacing:2px;text-align:center;">${inner}</div>`,
    underlay: (family, text, color) =>
      `<div style="font-family:'${family}';font-size:60px;line-height:1.15;font-weight:800;color:${color};padding:14px 30px;letter-spacing:2px;text-align:center;">${text}</div>`,
  },
  // Meme look without text-stroke (unsupported): heavy uppercase white on a
  // solid black chip that hugs the text.
  meme: {
    accent: "color:#ff5d1c",
    render: (family, inner) =>
      `<div style="text-align:center;"><span style="font-family:'${family}';font-size:64px;line-height:1.15;font-weight:900;color:#ffffff;background:#000000;padding:12px 28px;border-radius:10px;display:inline-block;text-transform:uppercase;">${inner}</span></div>`,
    underlay: (family, text, color) =>
      `<div style="text-align:center;"><span style="font-family:'${family}';font-size:64px;line-height:1.15;font-weight:900;color:${color};padding:12px 28px;display:inline-block;text-transform:uppercase;">${text}</span></div>`,
  },
};

const MAX_WORD_CLIPS = 400;

/**
 * Underlay track clips for the stroke/shadow caption effects: one clip per
 * cue (static full-cue text, no accent — it sits beneath the word-sync
 * caption clips which only differ by the accented word). Offset is relative
 * to the frame (0-1); dx/dy shift the copy so stacked tracks form an outline
 * or drop shadow.
 */
export function captionUnderlayClips(cues, { fontKey, style, dx = 0, dy = 0, color = "#000000", opacity }) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const family = captionFont(fontKey).family;
  const def = STYLES[style] ?? STYLES.classic;

  const offset = {};
  if (dx) offset.x = Math.round(dx * 10000) / 10000;
  const baseY = 0.08 + dy;
  offset.y = Math.round(baseY * 10000) / 10000;

  return cues.slice(0, 150).map((cue) => ({
    asset: {
      type: "html",
      html: def.underlay(family, escapeHtml(cue.text), color),
      width: 980,
      height: 260,
    },
    start: Math.max(0, Number(cue.start) || 0),
    length: Math.max(0.3, Number(cue.end) - Number(cue.start)),
    position: "bottom",
    offset,
    ...(opacity != null ? { opacity } : {}),
  }));
}

/**
 * Build the caption track clips. Cues with word timings render as one clip
 * per word with the spoken word accented (word-sync highlight); cues without
 * timings render as one static clip each. Returns [] when there are no cues.
 */
export function captionTrackClips(cues, { fontKey, style }) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const family = captionFont(fontKey).family;
  const def = STYLES[style] ?? STYLES.classic;

  const cueHtml = (cue, activeIndex) => {
    const words =
      Array.isArray(cue.words) && cue.words.length > 0
        ? cue.words.map((w) => escapeHtml(w.text))
        : escapeHtml(cue.text).split(/\s+/);
    return def.render(
      family,
      words
        .map((word, i) => (i === activeIndex ? `<span style="${def.accent}">${word}</span>` : word))
        .join(" ")
    );
  };

  const clip = (html, start, length) => ({
    asset: { type: "html", html, width: 980, height: 260 },
    start: Math.max(0, start),
    length: Math.max(0.08, length),
    position: "bottom",
    offset: { y: 0.08 },
  });

  const usableCues = cues.slice(0, 400);
  const wordClipTotal = usableCues.reduce(
    (sum, cue) => sum + (Array.isArray(cue.words) ? cue.words.length : 0),
    0
  );
  const wordSync = wordClipTotal > 0 && wordClipTotal <= MAX_WORD_CLIPS;

  const clips = [];
  for (const cue of usableCues) {
    if (!wordSync || !Array.isArray(cue.words) || cue.words.length === 0) {
      clips.push(clip(cueHtml(cue, -1), Number(cue.start) || 0, Number(cue.end) - Number(cue.start)));
      continue;
    }
    for (let i = 0; i < cue.words.length; i++) {
      const w = cue.words[i];
      const start = Math.max(0, Number(w.start) || 0);
      const end = Math.max(start + 0.08, Math.min(Number(w.end) || start + 0.2, Number(cue.end)));
      clips.push(clip(cueHtml(cue, i), start, end - start));
    }
  }
  return clips;
}
