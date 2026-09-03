import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env.js";

/**
 * RapidAPI video downloader.
 *
 * RapidAPI hosts many "YouTube/social downloader" APIs with different shapes.
 * This client calls the configured endpoint (RAPIDAPI_DOWNLOADER_URL) with the
 * source URL and tries common response shapes to locate a direct MP4 link:
 *   { link } | { url } | { videoUrl } | { formats: [...] } | { data: { ... } }
 */
export async function fetchDirectVideoUrl(sourceUrl) {
  if (!env.rapidapiKey || !env.rapidapiDownloaderUrl) {
    throw new Error(
      "RAPIDAPI_KEY / RAPIDAPI_DOWNLOADER_URL are not configured — cannot download from URL"
    );
  }

  const headers = {
    "X-RapidAPI-Key": env.rapidapiKey,
    "Content-Type": "application/json",
  };
  if (env.rapidapiHost) headers["X-RapidAPI-Host"] = env.rapidapiHost;

  const res = await fetch(env.rapidapiDownloaderUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: sourceUrl }),
  });
  if (!res.ok) {
    throw new Error(`RapidAPI downloader failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();

  const directUrl = findVideoUrl(data) ?? findVideoUrl({ nested: data });
  if (!directUrl) {
    throw new Error("RapidAPI response did not contain a downloadable video URL");
  }
  return directUrl;
}

function findVideoUrl(node, depth = 0) {
  if (depth > 4 || node == null) return null;

  if (typeof node === "string") {
    return /^https?:\/\/.+\.(mp4|mov|webm)(\?.*)?$/i.test(node) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findVideoUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    // Prefer the highest-quality mp4 in `formats` arrays when present.
    if (Array.isArray(node.formats)) {
      const candidates = node.formats
        .filter((f) => typeof f?.url === "string" && /\.mp4|video\/mp4/.test(`${f.url} ${f.mimeType ?? ""}`))
        .sort((a, b) => (Number(b.height ?? 0) || 0) - (Number(a.height ?? 0) || 0));
      if (candidates[0]?.url) return candidates[0].url;
    }
    for (const key of ["link", "url", "videoUrl", "video_url", "download_url", "file"]) {
      if (typeof node[key] === "string" && node[key].startsWith("http")) {
        return node[key];
      }
    }
    for (const value of Object.values(node)) {
      const found = findVideoUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
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
