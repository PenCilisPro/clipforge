import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env.js";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * RapidAPI video downloader (yt-api.p.rapidapi.com).
 *
 * The old `updated_metadata` endpoint was removed by the provider, so the
 * client now uses `GET /dl?id=<videoId>`, which returns the raw player
 * formats. Progressive (video+audio) mp4s are usually capped at 360p, so the
 * best video-only mp4 + best m4a audio track are downloaded separately and
 * muxed with ffmpeg stream copy.
 */
export async function fetchDirectVideoUrl(sourceUrl) {
  if (!env.rapidapiKey || !env.rapidapiDownloaderUrl) {
    throw new Error(
      "RAPIDAPI_KEY / RAPIDAPI_DOWNLOADER_URL are not configured — cannot download from URL"
    );
  }

  const videoId = extractYouTubeId(sourceUrl);
  if (!videoId) {
    throw new Error(
      `Unsupported source URL — only YouTube links are supported: ${sourceUrl}`
    );
  }

  const dlUrl = new URL(env.rapidapiDownloaderUrl);
  dlUrl.searchParams.set("id", videoId);
  const res = await fetch(dlUrl, {
    headers: {
      "X-RapidAPI-Key": env.rapidapiKey,
      "X-RapidAPI-Host": env.rapidapiHost ?? dlUrl.hostname,
    },
  });
  if (!res.ok) {
    throw new Error(`RapidAPI downloader failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (data?.status === "fail") {
    throw new Error(`RapidAPI downloader failed: ${data.error ?? "unknown error"}`);
  }

  const progressive = pickBestProgressive(data?.formats);
  if (progressive) return progressive.url;

  const best = pickBestVideoAudio(data?.adaptiveFormats);
  if (best?.videoUrl) return best.videoUrl;

  throw new Error("RapidAPI response did not contain a downloadable video URL");
}

/**
 * Download the source video to filePath. Prefers video+audio muxing for
 * quality (1080p), falls back to a progressive file when the API only
 * exposes one stream.
 */
export async function downloadSourceVideo(sourceUrl, filePath) {
  if (!env.rapidapiKey || !env.rapidapiDownloaderUrl) {
    throw new Error(
      "RAPIDAPI_KEY / RAPIDAPI_DOWNLOADER_URL are not configured — cannot download from URL"
    );
  }

  const videoId = extractYouTubeId(sourceUrl);
  if (!videoId) {
    throw new Error(
      `Unsupported source URL — only YouTube links are supported: ${sourceUrl}`
    );
  }

  const dlUrl = new URL(env.rapidapiDownloaderUrl);
  dlUrl.searchParams.set("id", videoId);
  const res = await fetch(dlUrl, {
    headers: {
      "X-RapidAPI-Key": env.rapidapiKey,
      "X-RapidAPI-Host": env.rapidapiHost ?? dlUrl.hostname,
    },
  });
  if (!res.ok) {
    throw new Error(`RapidAPI downloader failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (data?.status === "fail") {
    throw new Error(`RapidAPI downloader failed: ${data.error ?? "unknown error"}`);
  }

  const progressive = pickBestProgressive(data?.formats);
  if (progressive) {
    await downloadToFile(progressive.url, filePath);
    return filePath;
  }

  const best = pickBestVideoAudio(data?.adaptiveFormats);
  if (!best?.videoUrl) {
    throw new Error("RapidAPI response did not contain a downloadable video URL");
  }

  if (!best.audioUrl) {
    await downloadToFile(best.videoUrl, filePath);
    return filePath;
  }

  const { tmpPath, cleanup } = await import("./ffmpeg.js");
  const videoPart = tmpPath(`source-${videoId}-video.m4s`);
  const audioPart = tmpPath(`source-${videoId}-audio.m4a`);
  try {
    await downloadToFile(best.videoUrl, videoPart);
    await downloadToFile(best.audioUrl, audioPart);
    await runFfmpeg([
      "-i", videoPart,
      "-i", audioPart,
      "-c", "copy",
      "-movflags", "+faststart",
      filePath,
    ]);
  } finally {
    await cleanup(videoPart, audioPart);
  }
  return filePath;
}

function extractYouTubeId(sourceUrl) {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/(?:shorts|live|embed|v)\/([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = String(sourceUrl).match(pattern);
    if (match) return match[1];
  }
  if (/^[\w-]{11}$/.test(String(sourceUrl))) return sourceUrl;
  return null;
}

/** Highest-bitrate progressive mp4 (video + audio in one file). */
function pickBestProgressive(formats) {
  const candidates = (formats ?? []).filter(
    (f) => typeof f?.url === "string" && /^video\/mp4/.test(f?.mimeType ?? "")
  );
  candidates.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  return candidates[0] ?? null;
}

/** Best video-only mp4 + best m4a audio out of the adaptive formats. */
function pickBestVideoAudio(adaptiveFormats) {
  const streams = adaptiveFormats ?? [];
  const videos = streams.filter(
    (f) =>
      typeof f?.url === "string" &&
      /^video\/mp4/.test(f?.mimeType ?? "") &&
      // Prefer H.264 — safest for ffmpeg stream copy into an mp4 container.
      /avc1/.test(f?.mimeType ?? "")
  );
  if (videos.length === 0) {
    // Accept any codec rather than failing outright.
    videos.push(
      ...streams.filter(
        (f) => typeof f?.url === "string" && /^video\/mp4/.test(f?.mimeType ?? "")
      )
    );
  }
  videos.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

  const audios = streams
    .filter(
      (f) => typeof f?.url === "string" && /^audio\/mp4/.test(f?.mimeType ?? "")
    )
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

  if (videos.length === 0) return null;
  return { videoUrl: videos[0].url, audioUrl: audios[0]?.url ?? null };
}

/** Stream a direct URL to a local file. */
export async function downloadToFile(url, filePath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Video download failed (${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(filePath));
  return filePath;
}
