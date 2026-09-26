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
export function runFfmpeg(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFMPEG_PATH,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args],
      { stdio: ["ignore", "ignore", "pipe"], ...(cwd ? { cwd } : {}) }
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

/**
 * One ffprobe invocation for everything the transcribe stage needs (stream
 * layout + container duration). Two separate probes double the startup cost
 * on exactly the large sources where CPU is scarcest.
 */
export function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve({
        streams: data?.streams ?? [],
        duration: Number(data?.format?.duration ?? 0),
      });
    });
  });
}

/**
 * Extract the whole audio track as raw mono 16 kHz PCM in a single ffmpeg
 * pass (no WAV header — chunk boundaries are pure byte math at 32 000 B/s).
 * Per-chunk extraction would instead re-open and re-index a source-sized
 * MP4 once per 55 s of speech, saturating the 0.2 vCPU service for hours.
 */
export async function extractRawPcm(inputPath, outputPath) {
  return runFfmpeg([
    "-threads", "1",
    "-filter_threads", "1",
    "-i", inputPath,
    "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
    "-f", "s16le",
    outputPath,
  ]);
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
