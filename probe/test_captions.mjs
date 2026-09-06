import { captionTrackClips, captionUnderlayClips, captionFont, CAPTION_FONTS } from "../worker/src/lib/captions.js";

// Every configured font resolves and has a reachable-looking URL.
for (const [key, font] of Object.entries(CAPTION_FONTS)) {
  if (!font.src.startsWith("https://cdn.jsdelivr.net/gh/google/fonts@main/")) {
    throw new Error(`bad src for ${key}`);
  }
}
console.log("fonts:", Object.keys(CAPTION_FONTS).length, "→", Object.keys(CAPTION_FONTS).join(", "));

const cues = [
  { start: 0, end: 1.2, text: "This is a test cue", words: [
    { text: "This", start: 0, end: 0.3 },
    { text: "is", start: 0.3, end: 0.5 },
    { text: "a", start: 0.5, end: 0.6 },
    { text: "test", start: 0.6, end: 0.9 },
    { text: "cue.", start: 0.9, end: 1.2 },
  ]},
];

// Custom text color flows into the HTML; '#ffffff' falls back to per-template default.
const clip = captionTrackClips(cues, { fontKey: "pacifico", style: "highlighter", textColor: "#ff0000" });
if (!clip[0].asset.html.includes("color:#ff0000")) throw new Error("custom text color missing");
const auto = captionTrackClips(cues, { fontKey: "pacifico", style: "highlighter", textColor: "#ffffff" });
if (!auto[0].asset.html.includes("color:#111827")) throw new Error("template default color missing");
const white = captionTrackClips(cues, { fontKey: "green-screen", style: "royal", textColor: "#00ff00" });
if (!white[0].asset.html.includes("color:#00ff00")) throw new Error("custom color on royal missing");

// Every template renders + underlays still work.
for (const style of ["classic", "karaoke", "bold-pop", "neon", "meme", "green-screen", "highlighter", "ocean", "bubblegum", "royal", "minimal-mono"]) {
  const clips = captionTrackClips(cues, { fontKey: "bungee", style, textColor: "#123456" });
  if (clips.length === 0) throw new Error(`${style} produced no clips`);
  const under = captionUnderlayClips(cues, { fontKey: "bungee", style, dx: 0.004, dy: 0, color: "#000000" });
  if (under.length === 0) throw new Error(`${style} produced no underlay`);
}
console.log("caption render smoke test: OK");
