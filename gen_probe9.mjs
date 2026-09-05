// Probe 9: stroke/shadow on a WHITE background (black bg hides black underlays).
import { writeFileSync } from "node:fs";
import { buildCaptionsForClip, } from "./worker/src/lib/srt.js";
import { captionTrackClips, captionUnderlayClips, captionFont } from "./worker/src/lib/captions.js";

const words = [
  { word: "This", start: 10.0, end: 10.5 },
  { word: "trick", start: 10.5, end: 11.0 },
  { word: "will", start: 11.0, end: 11.3 },
  { word: "change", start: 11.3, end: 11.9 },
  { word: "everything", start: 11.9, end: 12.7 },
  { word: "forever", start: 12.7, end: 13.4 },
];
const { cues } = buildCaptionsForClip({ words }, 10, 14);
const style = "classic";
const fontKey = "russo-one";

const tracks = [];
tracks.push({ clips: captionTrackClips(cues, { fontKey, style }) });
for (const [dx, dy] of [[0.0045, 0], [-0.0045, 0], [0, 0.0045], [0, -0.0045]]) {
  tracks.push({
    clips: captionUnderlayClips(cues, { fontKey, style, dx, dy, color: "#000000" }),
  });
}
tracks.push({
  clips: captionUnderlayClips(cues, { fontKey, style, dx: 0.006, dy: 0.006, color: "#000000", opacity: 0.55 }),
});

const payload = {
  timeline: { background: "#ffffff", fonts: [{ src: captionFont(fontKey).src }], tracks },
  output: { format: "mp4", size: { width: 540, height: 960 }, fps: 24 },
};
writeFileSync("probe/probe_white.json", JSON.stringify(payload));
console.log("tracks:", tracks.length, "clips:", tracks.map((t) => t.clips.length).join(","));
