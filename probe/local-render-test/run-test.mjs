/**
 * Local render provider test — renders a synthetic 6 s clip end-to-end:
 * 9:16 crop + b-roll cutaway + music mix + word-synced ASS captions.
 * Run from the repo root: node probe/local-render-test/run-test.mjs
 */
process.env.TMP_DIR = new URL("./tmp/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
process.env.RENDER_PROVIDER = "local";

import fs from "node:fs/promises";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "@ffprobe-installer/ffprobe";
import { spawn } from "node:child_process";

ffmpeg.setFfprobePath(ffprobeStatic.path);

const TMP = process.env.TMP_DIR;
await fs.mkdir(TMP, { recursive: true });

function ff(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegStatic, ["-hide_banner", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

const source = path.join(TMP, "source.mp4");
const broll = path.join(TMP, "broll.mp4");
const tone = path.join(TMP, "tone.mp3");

console.log("generating test inputs…");
await ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", source]);
await ff(["-f", "lavfi", "-i", "smptebars=size=720x1280:rate=30:duration=10", "-c:v", "libx264", "-preset", "veryfast", broll]);
await ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "libmp3lame", tone]);

// --- unit: ASS generation ---
const localRender = await import("../../worker/src/lib/localRender.js");
const ass = localRender.buildAssSubtitles({
  captionCues: [
    {
      text: "hello world from local",
      start: 0.2,
      end: 2.8,
      words: [
        { text: "hello", start: 0.2, end: 0.8 },
        { text: "world", start: 0.8, end: 1.5 },
        { text: "from", start: 1.5, end: 1.9 },
        { text: "local", start: 1.9, end: 2.8 },
      ],
    },
    { text: "static cue here", start: 3.2, end: 5.6, words: [] },
  ],
  captionStyle: "bold-pop",
  captionTextColor: "#ffffff",
});
const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
console.log(`ASS: ${dialogueLines.length} dialogue events`);
if (dialogueLines.length !== 5) throw new Error(`expected 5 events (4 words + 1 static), got ${dialogueLines.length}`);
if (!ass.includes("{\\fsp1}")) throw new Error("letter-spacing tag missing");
if (!ass.includes("HELLO")) throw new Error("uppercase transform missing");
if (!ass.includes("\\c&H001C5DFF")) throw new Error("accent color tag missing");
const styleLine = ass.split("\n").find((l) => l.startsWith("Style:"));
if (!/^Style: Cap,Anton,68,.*,0,0,(3|1),0,0,2,60,60,154,1$/.test(styleLine)) throw new Error("box style line wrong: " + styleLine);
console.log("ASS generation OK");

// --- dispatch through renderProvider ---
const provider = await import("../../worker/src/lib/renderProvider.js");
if (provider.resolveRenderProvider() !== "local") throw new Error("provider should resolve to local");
console.log("provider resolves to:", provider.resolveRenderProvider());

const spec = provider.buildRenderSpec({
  sourceVideoUrl: source,
  sourceTrimSeconds: 2,
  durationSeconds: 6,
  watermarkUrl: null,
  brollClips: [{ start: 2, end: 4, src: broll }],
  musicTrack: { url: tone },
  captionCues: [
    {
      text: "hello world from local",
      start: 0.2,
      end: 2.8,
      words: [
        { text: "hello", start: 0.2, end: 0.8 },
        { text: "world", start: 0.8, end: 1.5 },
        { text: "from", start: 1.5, end: 1.9 },
        { text: "local", start: 1.9, end: 2.8 },
      ],
    },
    { text: "static cue here", start: 3.2, end: 5.6, words: [] },
  ],
  captionFontKey: "anton",
  captionStyle: "classic",
  captionTextColor: "#ffffff",
  captionStroke: false,
  captionShadow: true,
  captionShadowColor: "#000000",
  captionShadowSize: 6,
});

console.log("rendering locally (6 s @1080x1920)…");
const t0 = Date.now();
const renderId = await provider.submitRender(spec, null, { clipId: "testclip1" });
console.log(`render done in ${((Date.now() - t0) / 1000).toFixed(1)}s — id ${renderId}`);

const status = await provider.getRender(renderId);
if (status.status !== "done") throw new Error("getRender should report done: " + JSON.stringify(status));

const finalPath = path.join(TMP, "staged-final.mp4");
await provider.downloadRenderedClip(`local:${renderId}`, finalPath);
const stat = await fs.stat(finalPath);
console.log(`staged output: ${(stat.size / 1e6).toFixed(2)} MB`);

const info = await probe(finalPath);
const v = info.streams.find((s) => s.codec_type === "video");
const a = info.streams.find((s) => s.codec_type === "audio");
console.log(`output: ${v.width}x${v.height}, ${Number(info.format.duration).toFixed(2)}s, audio=${a ? a.codec_name : "none"}`);
if (v.width !== 1080 || v.height !== 1920) throw new Error("wrong dimensions");
if (Math.abs(Number(info.format.duration) - 6) > 1) throw new Error("wrong duration");
if (!a) throw new Error("no audio stream");

// recovery path: staged file was consumed — a second getRender reports failed
const after = await provider.getRender(renderId);
console.log("after staging, getRender:", after.status);

console.log("\nALL LOCAL RENDER TESTS PASSED");
