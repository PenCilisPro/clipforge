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

/** Run a raw ffmpeg command (spawn) and reject on non-zero exit. */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code, signal) =>
      code === 0
        ? resolve()
        : code === null
          ? // Null exit code = killed by a signal (OOM on small containers).
            reject(new Error(`ffmpeg was killed by signal ${signal} (likely out of memory)`))
          : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`))
    );
    proc.on("error", reject);
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

/** Extract mono 16 kHz WAV for Speech-to-Text:
 *   ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.wav
 */
export async function extractAudio(inputPath, outputPath) {
  return runFfmpeg([
    "-i", inputPath,
    "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
    outputPath,
  ]);
}

/**
 * Trim an accurate segment. Re-encodes for frame-accurate cuts — stream copy
 * (-c copy) snaps to keyframes and desyncs captions on variable-keyframe files.
 * Downscales anything above 1080p first: re-encoding 4K with libx264 blows
 * past small containers' RAM (two concurrent trims get OOM-killed).
 */
export async function trimSegment(inputPath, outputPath, startSeconds, durationSeconds) {
  return runFfmpeg([
    "-ss", String(startSeconds),
    "-i", inputPath,
    "-t", String(durationSeconds),
    "-vf", "scale='min(1920,iw)':-2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

/** Grab a vertical thumbnail from a clip. */
export async function generateThumbnail(inputPath, outputPath, atSeconds = 1) {
  return runFfmpeg([
    "-ss", String(Math.max(0, atSeconds)),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",
    "-q:v", "3",
    outputPath,
  ]);
}

export async function cleanup(...paths) {
  await Promise.all(
    paths.filter(Boolean).map((p) => fs.rm(p, { force: true, recursive: true }).catch(() => {}))
  );
}

/**
 * Stream a URL straight to disk. Buffering a whole source video in RAM
 * (e.g. storage.download → Buffer) OOM-kills small containers before ffmpeg
 * even starts; the bytes belong on disk, not in the heap.
 */
export async function downloadToFile(url, filePath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(filePath));
  return filePath;
}
