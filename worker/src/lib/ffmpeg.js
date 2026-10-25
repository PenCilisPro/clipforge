import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "@ffprobe-installer/ffprobe";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Distro ffmpeg inside Modal (override), static binary everywhere else.
const FFMPEG_PATH = process.env.FFMPEG_PATH_OVERRIDE || ffmpegStatic;
// ffprobe needs the same escape hatch: without it probes kept running the
// STATIC glibc ffprobe even when ffmpeg was overridden — and on Alpine
// (musl) containers the static binaries cannot resolve DNS at all (their
// getaddrinfo tries to dlopen glibc NSS modules that do not exist there,
// so every https input failed with "Failed to resolve hostname ...:
// System error" while Node's own fetch resolved the same host fine).
const FFPROBE_PATH = process.env.FFPROBE_PATH_OVERRIDE || ffprobeStatic.path;
console.log("[ffmpeg] using binary:", FFMPEG_PATH);
console.log("[ffprobe] using binary:", FFPROBE_PATH);
ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

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
// 35 min, not the old 15: the 1080x1920 encode on a ~0.2 vCPU container is
// extremely slow (observed 12+ min and still encoding), and the render JOB
// itself dies at JOB_TIMEOUT_MS = 40 min (src/index.js) — ffmpeg's own kill
// must fire first so the job fails with a real ffmpeg reason (and the
// SIGKILL fallbacks below can still engage) instead of a bare wrapper
// timeout. Set FFMPEG_TIMEOUT_MS to override.
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS) || 35 * 60 * 1000;

// Run every ffmpeg at the LOWEST CPU priority. A local encode saturates a
// small container's only vCPU: API responses stretched to minutes, platform
// health checks timed out, the service got restarted mid-render — and the
// gateway's 502 pages carry no CORS headers, so the browser shows CORS
// errors while the backend config was never wrong. nice 19 costs the encode
// almost nothing when the box is idle but guarantees the API, Redis and
// health probes stay scheduable while it runs. Set FFMPEG_NICE=0 to disable
// (busybox-less images fall back to a plain spawn automatically).
const FFMPEG_NICE = process.env.FFMPEG_NICE === "0" ? false : true;

// Warn ONCE when the nice applet is missing from the image (busybox-less
// distroless-style bases) — a silent fallback made it impossible to tell
// from container logs whether encodes were actually running at low priority.
let warnedNiceMissing = false;

/** Run a raw ffmpeg command (spawn) and reject on non-zero exit. */
export function runFfmpeg(args, { cwd } = {}) {
  const run = (useNice) =>
    new Promise((resolve, reject) => {
      const prefix = useNice ? ["nice", "-n", "19", FFMPEG_PATH] : [FFMPEG_PATH];
      const proc = spawn(
        prefix[0],
        [...prefix.slice(1), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args],
        { stdio: ["ignore", "ignore", "pipe"], ...(cwd ? { cwd } : {}) }
      );
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        // The message deliberately names the signal: submitRender's and
        // trimSegment's /SIGKILL/i fallbacks treat a kill as an overload
        // signal — a timeout IS one, so the lighter-encode retry engages
        // instead of failing the clip outright.
        reject(new Error(`ffmpeg timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 60000)} min and was killed by signal SIGKILL: ${stderr.slice(-400)}`));
      }, FFMPEG_TIMEOUT_MS);
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        if (code === null) {
          return reject(
            new Error(`ffmpeg was killed by signal ${signal}: ${stderr.slice(-1200)}`)
          );
        }
        // Exit code 228 (= -28) with "No space left on device" is ENOSPC —
        // reframe it around the disk that actually filled, keeping the raw
        // stderr tail for diagnosis. Async enrichment inside a Promise
        // executor is safe here: reject is idempotent.
        withDiskContext(code, stderr).then(reject, reject);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        // Some minimal images ship busybox without the nice applet — fall
        // back to a plain spawn once instead of failing every ffmpeg call.
        if (useNice && err?.code === "ENOENT") {
          err.fallbackToPlain = true;
          if (!warnedNiceMissing) {
            warnedNiceMissing = true;
            console.warn(
              "[ffmpeg] 'nice' not found in this image — encodes will run at NORMAL CPU priority. "
                + "Install busybox/coreutils or set FFMPEG_NICE=0 to silence this warning."
            );
          }
        }
        reject(err);
      });
    });
  return run(FFMPEG_NICE).catch((err) =>
    err?.fallbackToPlain ? run(false) : Promise.reject(err)
  );
}

/**
 * Wrap a non-zero ffmpeg exit in disk context when stderr shows ENOSPC
 * ("No space left on device"). The worker's ~1 GiB ephemeral disk fills
 * fastest during audio extraction (raw PCM ≈ 115 MB per hour of video) and
 * legacy split-upload reassembly (a source-sized MP4 lands here first), so
 * the message names the real limits instead of a bare muxer error.
 */
async function withDiskContext(code, stderr) {
  const base = new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`);
  if (!/no space left on device/i.test(stderr)) return base;
  const free = await statDiskFree().catch(() => null);
  const freeText = free == null ? "unknown" : formatMb(free);
  return new Error(
    `ffmpeg exited ${code} — the worker's disk is FULL (No space left on device; ` +
      `${TMP_DIR} has ${freeText} free). Transcription audio takes ~115 MB per hour of ` +
      `video, and legacy split uploads also reassemble the whole source file in this ` +
      `same temp space. Stale temp files are swept automatically before each job; if ` +
      `this keeps happening, increase the worker service's disk size (Northflank → ` +
      `service → resources) or use a shorter source. Raw stderr: ${stderr.slice(-400)}`
  );
}

/**
 * Pick the most truthful duration ffprobe offered. format.duration is
 * preferred, but raw DASH downloads (yt-dlp .webm/.opus files that were
 * never remuxed into a seekable container) report "N/A" there — and
 * Number("N/A") is NaN, which every caller silently treated as "no
 * duration". Fall back to the largest finite per-stream duration, and
 * finally 0. Never returns NaN.
 */
function pickProbeDuration(data) {
  const formatDuration = Number(data?.format?.duration);
  if (Number.isFinite(formatDuration) && formatDuration > 0) return formatDuration;
  let best = 0;
  for (const stream of data?.streams ?? []) {
    const streamDuration = Number(stream?.duration);
    if (Number.isFinite(streamDuration) && streamDuration > best) best = streamDuration;
  }
  return best;
}

export function probeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(pickProbeDuration(data));
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
        duration: pickProbeDuration(data),
      });
    });
  });
}

/**
 * Does this ffmpeg failure mean "could not READ the remote input" rather
 * than "the file is bad"? Matches the DNS/TLS/transport error family that
 * static-glibc ffmpeg builds produce on musl containers (and, generally,
 * any network-level failure reading an https input):
 *   [tcp @ ...] Failed to resolve hostname ...: System error
 *   Error opening input: Input/output error
 * "killed by signal" is included for the same class: the static-glibc
 * binaries sometimes SEGFAULT inside their broken getaddrinfo/NSS path
 * instead of printing a clean error (observed in sandbox testing — the
 * Alpine container shows "System error", a glibc host may crash outright).
 * Callers use this to decide whether re-reading the same media from a
 * LOCAL copy (downloaded via Node, whose resolver works) is worth trying.
 */
export function isRemoteUnreadableError(rawMessage) {
  const msg = String(rawMessage ?? "");
  return (
    /failed to resolve|could not resolve|name or service not known|temporary failure in name resolution|network is unreachable|no route to host|connection (?:refused|reset|timed out)|input\/output error|protocol not found|handshake|certificate|\btls\b|\bssl\b|(?:http error|server returned) 40[34]|killed by signal/i.test(
      msg
    )
  );
}

/**
 * Parse the total size out of a Content-Range header ("bytes 0-0/12345").
 * Returns null for anything malformed (including "bytes 0-0/*" — unknown
 * length) so callers can skip their size guard gracefully.
 */
export function contentRangeTotal(header) {
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(header ?? ""));
  const total = match ? Number(match[1]) : NaN;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Size of a remote object without downloading it: a 1-byte Range request
 * whose Content-Range header carries the total. Range is NOT part of the
 * AWS SigV4 signed headers, so this works against presigned GET URLs —
 * the same mechanism ffmpeg itself uses to seek inside them. Returns null
 * whenever the probe cannot complete (never throws: it is best-effort
 * insurance before a source-sized local download).
 */
export async function probeRemoteSize(url) {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    const total = contentRangeTotal(res.headers.get("content-range"));
    if (res.body) await res.body.cancel().catch(() => {});
    return res.ok && total ? total : null;
  } catch {
    return null;
  }
}

/**
 * Map the two common audio-extraction failures to a readable message and
 * return null for everything else (caller re-throws the original error).
 *  - The file genuinely has no audio stream ("Output file #0 does not
 *    contain any stream" — ffmpeg cannot satisfy -vn + pcm output).
 *  - The worker's ffmpeg build lacks https/TLS protocol support, so it
 *    cannot read the presigned R2 URL remotely.
 */
export function describeExtractionFailure(rawMessage) {
  const msg = String(rawMessage ?? "");
  if (
    /does not contain any stream|matches no streams|matches no audio streams|Stream map/i.test(msg)
  ) {
    return (
      "Audio extraction failed: this file has no audio stream. " +
      "For a pasted link, re-run the project — the downloader verifies the audio " +
      "track is merged; for an upload, use a version of the video that has sound."
    );
  }
  if (/protocol not found|handshake|certificate|tls|ssl/i.test(msg)) {
    return (
      "Audio extraction failed: the worker's ffmpeg build could not read the " +
      "remote video URL (" +
      msg.slice(0, 200) +
      "). Re-upload the video file directly, or install an ffmpeg build with " +
      "TLS support in the worker image."
    );
  }
  return null;
}

/**
 * Extract the whole audio track as raw mono 16 kHz PCM in a single ffmpeg
 * pass (no WAV header — chunk boundaries are pure byte math at 32 000 B/s).
 * Per-chunk extraction would instead re-open and re-index a source-sized
 * MP4 once per 55 s of speech, saturating the 0.2 vCPU service for hours.
 */
export async function extractRawPcm(inputPath, outputPath) {
  // Remote inputs (presigned R2 URLs) get reconnect flags so one dropped
  // HTTP range read doesn't sink a multi-hour extraction near the end.
  const netFlags = /^https?:\/\//i.test(String(inputPath))
    ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
    : [];
  return runFfmpeg([
    ...netFlags,
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
    // Lanczos downscale + q:v 2: the old default scaler + q:v 3 made posters
    // visibly soft in the dashboard grid.
    "-vf", "scale=720:1280:force_original_aspect_ratio=increase:flags=lanczos,crop=720:1280",
    "-q:v", "2",
    "-threads", "1",
    outputPath,
  ]);
}

export async function cleanup(...paths) {
  await Promise.all(
    paths.filter(Boolean).map((p) => fs.rm(p, { force: true, recursive: true }).catch(() => {}))
  );
}

/**
 * Wipe TMP_DIR contents (intended for worker startup). A crashed job leaves
 * source videos / PCM / temp files behind, and the container only has ~1 GiB
 * of ephemeral disk — filenames are per-job UUIDs, so nothing here is
 * stateful and safe to delete.
 */
export async function sweepTmpDir() {
  await ensureTmpDir();
  const entries = await fs.readdir(TMP_DIR).catch(() => []);
  await Promise.all(
    entries.map((entry) =>
      fs.rm(path.join(TMP_DIR, entry), { force: true, recursive: true }).catch(() => {})
    )
  );
}

/**
 * Free bytes on the filesystem holding TMP_DIR, or null when the platform
 * can't report it (fs.statfs needs Node ≥ 18.15; older runtimes skip every
 * disk assertion instead of failing jobs over a missing API).
 */
export async function statDiskFree(targetPath = TMP_DIR) {
  if (typeof fs.statfs !== "function") return null;
  try {
    const stats = await fs.statfs(targetPath);
    const blockSize = Number(stats.bsize) || 4096;
    const available = Number(stats.bavail);
    if (!Number.isFinite(available)) return null;
    return Math.max(0, available * blockSize);
  } catch {
    return null;
  }
}

// Files in TMP_DIR older than this are crashed-job leftovers and safe to
// delete even while other work runs: the longest legitimate temp-file
// lifetime is a transcribe stage BullMQ already timed out (120 min) plus
// ffmpeg's own kill (35 min) — 3 h clears everything past that with margin.
// Set TMP_STALE_MS to override.
const TMP_STALE_MS = Number(process.env.TMP_STALE_MS) || 3 * 60 * 60 * 1000;

/**
 * Shared sweeper. Deletes TMP_DIR entries filtered by age, skipping any
 * path in `protect` (exact resolved match). Returns what it reclaimed so
 * callers can log real numbers. Publishing never touches TMP_DIR and the
 * pipeline queue runs at concurrency 1, so the only entries at risk are
 * zombie stages from withTimeout races — whose results are discarded anyway.
 */
async function sweepTmpDirEntries({ olderThanMs = 0, protect = [] } = {}) {
  await ensureTmpDir();
  const entries = await fs.readdir(TMP_DIR).catch(() => []);
  const cutoff = Date.now() - olderThanMs;
  const protectSet = new Set(protect.filter(Boolean).map((p) => path.resolve(p)));
  let removed = 0;
  let bytes = 0;
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(TMP_DIR, entry);
      if (protectSet.has(path.resolve(fullPath))) return;
      try {
        const stats = await fs.stat(fullPath);
        if (stats.mtimeMs < cutoff) {
          bytes += Number(stats.size) || 0;
          await fs.rm(fullPath, { force: true, recursive: true });
          removed += 1;
        }
      } catch {
        // Vanished mid-sweep or unreadable — nothing to reclaim, move on.
      }
    })
  );
  if (removed > 0) {
    console.log(
      `[ffmpeg] swept ${removed} temp file(s) (~${formatMb(bytes)}) from ${TMP_DIR}` +
        (olderThanMs > 0 ? ` (older than ${Math.round(olderThanMs / 60000)} min)` : "")
    );
  }
  return { removed, bytes };
}

/**
 * Age-filtered sweep: delete only TMP_DIR entries last modified before the
 * stale window. Safe to call mid-flight — a timed-out stage still writing
 * through its background ffmpeg keeps its files until they genuinely go
 * stale.
 */
export async function sweepStaleTmpFiles(maxAgeMs = TMP_STALE_MS) {
  return sweepTmpDirEntries({ olderThanMs: maxAgeMs });
}

function formatMb(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Fail fast — with a human-readable reason — when TMP_DIR cannot fit the
 * bytes a stage is about to write, reclaiming what it can first:
 *   tier 1 — sweep stale leftovers (> 3 h old);
 *   tier 2 — if still short, sweep EVERYTHING not in `protect` (stranded
 *            downloads from failed attempts are minutes old, so tier 1
 *            alone never fixes a 0-byte disk; the only collateral is
 *            zombie stages from timeout races, whose results are already
 *            discarded);
 *   tier 3 — throw the readable error.
 * A no-op on platforms without statfs.
 */
export async function assertDiskSpace(
  needBytes,
  { label = "this stage", protect = [], reclaimAll = true } = {}
) {
  // statfs on a missing path throws ENOENT → null → silent skip, so make
  // sure TMP_DIR exists before measuring (first job on a fresh container).
  await ensureTmpDir();
  let free = await statDiskFree();
  if (free == null) return;
  if (free >= needBytes) return;

  await sweepStaleTmpFiles();
  free = await statDiskFree();
  if (free >= needBytes) return;

  if (reclaimAll) {
    console.warn(
      `[ffmpeg] disk still short for ${label} (${formatMb(free)} free, ` +
        `${formatMb(needBytes)} needed) — aggressively reclaiming ALL unprotected temp files`
    );
    await sweepTmpDirEntries({ olderThanMs: 0, protect });
    free = await statDiskFree();
    if (free >= needBytes) return;
  }

  if (free != null) {
    throw new Error(
      `Not enough disk space for ${label}: needs ~${formatMb(needBytes)} but only ` +
        `${formatMb(free)} is free in ${TMP_DIR} (even after sweeping temp files). ` +
        `The worker's ephemeral disk is ~1 GiB and transcription audio alone takes ` +
        `~115 MB per hour of video — increase the worker service's disk size or retry ` +
        `with a shorter source video.`
    );
  }
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