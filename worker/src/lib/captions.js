/**
 * HTML caption rendering.
 *
 * Shotstack's native `caption` asset accepts no styling on the stage API and
 * ignores timeline fonts, and — critically — the FIRST track in the timeline
 * is the TOPMOST layer (probe-verified), so captions must sit before the
 * video track or a full-screen clip covers them.
 *
 * We therefore render each caption cue as an HTML text clip with a real font
 * file (timeline.fonts expects .ttf/.otf URLs — CSS like fonts.cdnfonts.com
 * is ignored and falls back to a generic sans).
 */

// All URLs verified reachable; families match the font metadata.
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
