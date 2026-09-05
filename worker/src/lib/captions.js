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
 * filter/drop-shadow. Template styles therefore use colored text + rounded
 * boxes only; shadows/strokes in the existing styles are inert leftovers.
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

const STYLES = {
  classic: (text, family) =>
    `<div style="font-family:'${family}';font-size:64px;line-height:1.15;font-weight:700;color:#ffffff;text-align:center;text-shadow:0 3px 10px rgba(0,0,0,.9),0 0 4px rgba(0,0,0,.8);padding:0 12px;">${text}</div>`,
  karaoke: (text, family) =>
    `<div style="font-family:'${family}';font-size:60px;line-height:1.15;font-weight:800;color:#ffffff;background:rgba(255,93,28,.92);padding:14px 30px;border-radius:16px;text-align:center;">${text}</div>`,
  "bold-pop": (text, family) =>
    `<div style="font-family:'${family}';font-size:68px;line-height:1.1;font-weight:900;color:#ffffff;background:rgba(0,0,0,.78);padding:16px 30px;border-radius:14px;text-transform:uppercase;letter-spacing:1px;text-align:center;">${text}</div>`,
  // Neon sign: light-cyan text on a dark translucent slab (glow effects are
  // ignored by the stage renderer — see capability notes above).
  neon: (text, family) =>
    `<div style="font-family:'${family}';font-size:60px;line-height:1.15;font-weight:800;color:#67e8f9;background:rgba(3,28,41,.85);padding:14px 30px;border-radius:16px;letter-spacing:2px;text-align:center;">${text}</div>`,
  // Meme look without text-stroke (unsupported): heavy uppercase white on a
  // solid black chip that hugs the text.
  meme: (text, family) =>
    `<div style="text-align:center;"><span style="font-family:'${family}';font-size:64px;line-height:1.15;font-weight:900;color:#ffffff;background:#000000;padding:12px 28px;border-radius:10px;display:inline-block;text-transform:uppercase;">${text}</span></div>`,
};

/**
 * Build the caption track clips (HTML text per cue, clip-local times).
 * Returns an empty array when there are no cues — no captions, no track.
 */
export function captionTrackClips(cues, { fontKey, style }) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const family = captionFont(fontKey).family;
  const render = STYLES[style] ?? STYLES.classic;

  return cues.slice(0, 400).map((cue) => ({
    asset: {
      type: "html",
      html: render(escapeHtml(cue.text), family),
      width: 980,
      height: 260,
    },
    start: Math.max(0, Number(cue.start) || 0),
    length: Math.max(0.3, Number(cue.end) - Number(cue.start)),
    position: "bottom",
    offset: { y: 0.08 },
  }));
}
