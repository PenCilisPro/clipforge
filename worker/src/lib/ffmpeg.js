import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "@ffprobe-installer/ffprobe";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Always use the bundled static binaries — never a user/env-supplied path.
const FFMPEG_PATH = ffmpegStatic;
ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(ffprobeStatic.path);

export const TMP_DIR = process.env.TMP_DIR ?? "/tmp/clipforge";

export async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

export function tmpPath(name) {
  return path.join(TMP_DIR, `${crypto.randomUUID()}-${name}`);
}

// ffmpeg must never hold a worker slot forever — a hung or thrashing encode
// would otherwise deadlock the whole pipeline (this shipped once: every clip
// sat in "rendering" for days with no error recorded anywhere).
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS) || 15 * 60 * 1000;

/** Run a raw ffmpeg command (spawn) and reject on non-zero exit. */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFMPEG_PATH,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 60000)} min: ${stderr.slice(-400)}`));
    }, FFMPEG_TIMEOUT_MS);
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : code === null
          ? reject(new Error(`ffmpeg was killed by signal ${signal} (likely out of memory)`))
          : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function probeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(Number(data?.format?.duration ?? 0));
    });
  });
}

export function probeStreams(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data?.streams ?? []);
    });
  });
}

/** Extract mono 16 kHz WAV for Speech-to-Text:
 *   ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.wav
 */
export async function extractAudio(inputPath, outputPath, startSeconds = 0, durationSeconds = null) {
  const args = ["-threads", "1", "-filter_threads", "1"];
  if (startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", inputPath);
  if (durationSeconds != null) args.push("-t", String(durationSeconds));
  args.push("-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outputPath);
  return runFfmpeg(args);
}

/**
 * Split an audio file into fixed-length WAV chunks that each stay under
 * Google STT's inline limits (60s duration AND 10 MiB payload; 55s of
 * 16 kHz mono PCM ≈ 1.7 MB raw ≈ 2.3 MB base64). Returns
 * [{path, startSeconds}] covering the file in order; the last chunk carries
 * whatever remains.
 */
export async function splitAudioChunks(inputPath, chunkSeconds = 55) {
  const duration = await probeDurationSeconds(inputPath);
  if (!duration || duration <= chunkSeconds) return [{ path: inputPath, startSeconds: 0 }];
  const chunks = [];
  for (let start = 0; start < duration; start += chunkSeconds) {
    const out = tmpPath(`audio-chunk-${start}.wav`);
    await runFfmpeg([
      "-ss", String(start),
      "-i", inputPath,
      "-t", String(chunkSeconds),
      "-c:a", "pcm_s16le",
      out,
    ]);
    chunks.push({ path: out, startSeconds: start });
  }
  return chunks;
}

// Heavy re-encode trims are serialized: two concurrent 4K trims OOM small
// containers (512MB on Railway's trial plan). Other stages stay concurrent.
let trimChain = Promise.resolve();

/**
 * Trim an accurate segment. Re-encodes for frame-accurate cuts — stream copy
 * (-c copy) snaps to keyframes and desyncs captions on variable-keyframe files.
 * Downscales anything above 1080p first: re-encoding 4K with libx264 blows
 * past small containers' RAM (two concurrent trims get OOM-killed).
 * If the container's OOM killer still takes ffmpeg out (SIGKILL), retry once
 * at 720p with a cheaper encoder config rather than failing the clip.
 */
export async function trimSegment(inputPath, outputPath, startSeconds, durationSeconds) {
  const args = (maxHeight, crf) => [
    "-threads", "1",
    "-filter_threads", "1",
    "-ss", String(startSeconds),
    "-i", inputPath,
    "-t", String(durationSeconds),
    "-vf", `scale='min(1920,iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-threads", "1",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ];
  const run = (a) => {
    const p = trimChain.then(() => runFfmpeg(a));
    trimChain = p.then(() => {}, () => {});
    return p;
  };

  try {
    return await run(args(1080, 20));
  } catch (err) {
    if (!/signal SIGKILL/.test(err.message)) throw err;
    console.warn("[ffmpeg] trim OOM-killed — retrying at 720p with a lighter encode");
    return run(args(720, 23));
  }
}

/** Grab a vertical thumbnail from a clip. */
export async function generateThumbnail(inputPath, outputPath, atSeconds = 1) {
  return runFfmpeg([
    "-threads", "1",
    "-filter_threads", "1",
    "-ss", String(Math.max(0, atSeconds)),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",
    "-q:v", "3",
    "-threads", "1",
    outputPath,
  ]);
}

export async function cleanup(...paths) {
  await Promise.all(
    paths.filter(Boolean).map((p) => fs.rm(p, { force: true, recursive: true }).catch(() => {}))
  );
}

/** Stream a URL straight to disk; do not buffer an entire video in RAM. */
export async function downloadToFile(url, filePath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(filePath));
  return filePath;
}
