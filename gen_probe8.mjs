// Probe 8: stroke + shadow underlay tracks via the real worker code path.
import { writeFileSync } from "node:fs";
import { buildCaptionsForClip } from "./worker/src/lib/srt.js";
import { buildEditJson } from "./worker/src/lib/shotstack.js";

const words = [
  { word: "This", start: 10.0, end: 10.4 },
  { word: "trick", start: 10.4, end: 10.9 },
  { word: "will", start: 10.9, end: 11.2 },
  { word: "change", start: 11.2, end: 11.7 },
  { word: "everything", start: 11.7, end: 12.6 },
  { word: "forever", start: 12.6, end: 13.4 },
];

const { cues } = buildCaptionsForClip({ words }, 10, 14);
const editJson = buildEditJson({
  rawClipUrl:
    "https://shotstack-api-stage-output.s3-ap-southeast-2.amazonaws.com/u6lfttv6a6/23bbf937-9099-4ade-94c4-fbf3ae6c6c06.mp4",
  durationSeconds: 3.5,
  watermarkUrl: null,
  brollClips: [],
  musicTrack: null,
  captionCues: cues,
  captionFontKey: "russo-one",
  captionStyle: "classic",
  captionStroke: true,
  captionShadow: true,
});

writeFileSync("probe/probe_effects2.json", JSON.stringify(editJson));
console.log("tracks:", editJson.timeline.tracks.length, "clips/track:", editJson.timeline.tracks.map((t) => t.clips.length).join(","));
