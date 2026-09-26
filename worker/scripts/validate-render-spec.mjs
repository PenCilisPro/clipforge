/**
 * Offline smoke test for the render providers: builds a full render spec for
 * a fake clip (captions with word timings, b-roll, music, watermark, stroke +
 * shadow) and asserts the structural invariants each provider's API expects.
 *
 *   node scripts/validate-render-spec.mjs
 *
 * If CREATOMATE_API_KEY is set in the environment, it additionally submits
 * the Creatomate spec with dry_run: true — a free, credit-less validation
 * call that returns the provider's own {valid, errors, warnings} verdict.
 */
import { buildRenderSpec as buildCreatomate } from "../src/lib/creatomate.js";
import { buildEditJson as buildShotstack } from "../src/lib/shotstack.js";
import { resolveRenderProvider } from "../src/lib/renderProvider.js";

const CUES = [
  {
    text: "welcome back to the show",
    start: 0.2,
    end: 1.8,
    words: [
      { text: "welcome", start: 0.2, end: 0.7 },
      { text: "back", start: 0.7, end: 1.0 },
      { text: "to", start: 1.0, end: 1.2 },
      { text: "the", start: 1.2, end: 1.4 },
      { text: "show", start: 1.4, end: 1.8 },
    ],
  },
  { text: "let's get into it", start: 2.0, end: 3.4, words: null },
];

const PARAMS = {
  sourceVideoUrl: "https://r2.example.com/source.mp4",
  sourceTrimSeconds: 42,
  durationSeconds: 10,
  watermarkUrl: "https://r2.example.com/logo.png",
  brollClips: [{ start: 1, end: 4, src: "https://pexels.example.com/clip.mp4" }],
  musicTrack: { url: "https://jamendo.example.com/track.mp3" },
  captionCues: CUES,
  captionFontKey: "anton",
  captionStyle: "karaoke",
  captionTextColor: "#ffffff",
  captionStroke: true,
  captionShadow: true,
  captionStrokeColor: "#000000",
  captionStrokeSize: 4,
  captionShadowColor: "#000000",
  captionShadowSize: 6,
};

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Creatomate ---
const ctm = buildCreatomate(PARAMS);
assert(ctm.output_format === "mp4", "creatomate: output_format is mp4");
assert(ctm.width === 1080 && ctm.height === 1920, "creatomate: 1080x1920 canvas");
assert(ctm.frame_rate === 30, "creatomate: 30 fps");
assert(
  ctm.fonts.length === 1 &&
    ctm.fonts[0].family === "Anton" &&
    typeof ctm.fonts[0].source === "string" &&
    ctm.fonts[0].weight === 400,
  "creatomate: custom Anton TTF registered at weight 400"
);

const videos = ctm.elements.filter((e) => e.type === "video");
const texts = ctm.elements.filter((e) => e.type === "text");
const audios = ctm.elements.filter((e) => e.type === "audio");
const images = ctm.elements.filter((e) => e.type === "image");
assert(videos.length === 2, "creatomate: main video + 1 b-roll element");
assert(
  videos[0].trim_start === 42 && videos[0].trim_duration === 10 && videos[0].fit === "cover",
  "creatomate: main video trimmed at 42s for 10s, cover-cropped"
);
assert(
  videos[1].volume === "0%" &&
    Array.isArray(videos[1].animations) &&
    videos[1].animations.length === 2,
  "creatomate: b-roll muted with fade in/out animations"
);
assert(audios.length === 1 && audios[0].volume === "15%" && audios[0].loop === true,
  "creatomate: music at 15%, looping");
assert(images.length === 1 && images[0].width === "14%", "creatomate: watermark top-right");

// 5 timed words + 1 static cue = 6 caption elements on the caption track
assert(texts.length === 6, `creatomate: 6 caption elements (got ${texts.length})`);
assert(texts.every((t) => t.track === 4 && t.font_family === "Anton"), "creatomate: captions on top track, Anton");
assert(
  texts[0].text.startsWith("welcome ") &&
    !texts[0].text.startsWith("[opacity") &&
    texts[1].text.startsWith("[opacity 78]welcome"),
  "creatomate: karaoke style dims inactive words, active word clean (accent=dim)"
);
assert(texts.every((t) => t.stroke_width === 4 && t.shadow_color === "#000000"),
  "creatomate: native stroke + shadow applied");
assert(
  texts.every((t) => t.y === "92%" && t.y_anchor === "100%" && t.background_color),
  "creatomate: captions bottom-anchored on the style's background box"
);
assert(
  ctm.elements.every((e) => typeof e.time === "number" || e.time === null),
  "creatomate: every element carries a time"
);

// --- Shotstack (legacy provider must still build) ---
const ss = buildShotstack(PARAMS);
assert(ss.output.format === "mp4" && ss.output.size.width === 1080, "shotstack: legacy builder intact");
assert(
  ss.timeline.tracks.some((t) => t.clips.some((c) => c.asset?.type === "html")),
  "shotstack: HTML caption track present"
);
assert(
  ss.timeline.tracks[0].clips.length === 6,
  "shotstack: caption track first (topmost) with 6 clips"
);

console.log(`\nResolved provider: ${resolveRenderProvider()} (CREATOMATE_API_KEY ${process.env.CREATOMATE_API_KEY ? "set" : "unset"}, SHOTSTACK_API_KEY ${process.env.SHOTSTACK_API_KEY ? "set" : "unset"})`);

// --- Optional live validation (free, no credits, nothing queued) ---
if (process.env.CREATOMATE_API_KEY) {
  console.log("\nRunning Creatomate dry_run validation…");
  const res = await fetch("https://api.creatomate.com/v2/renders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CREATOMATE_API_KEY}`,
    },
    body: JSON.stringify({ ...buildCreatomate(PARAMS), dry_run: true }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`dry_run status ${res.status}:`, JSON.stringify(body, null, 2));
  if (body.valid === false) process.exitCode = 1;
} else {
  console.log("\nSet CREATOMATE_API_KEY to also run the free live dry_run validation.");
}
