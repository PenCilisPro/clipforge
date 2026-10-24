import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env.js";

/**
 * Modal yt-dlp downloader client (modal/modal_download.py) — the $0
 * replacement for the paid RapidAPI downloader. Auth reuses the render
 * app's shared secret (same X-Render-Secret header, same MODAL_RENDER_SECRET
 * env var), so no new configuration beyond MODAL_DOWNLOAD_URL.
 *
 * The MP4 streams straight from the Modal container to filePath — the worker
 * never buffers it in memory and never talks to YouTube itself, so YouTube's
 * datacenter-IP bot checks apply to Modal's egress, not this tiny container.
 */
export async function downloadSourceVideoViaModal(sourceUrl, filePath) {
  if (!env.modalDownloadUrl) {
    throw new Error("MODAL_DOWNLOAD_URL is not configured — yt-dlp downloader unavailable");
  }
  if (!env.modalRenderSecret) {
    throw new Error(
      "MODAL_RENDER_SECRET is not configured — cannot authenticate the yt-dlp downloader"
    );
  }

  const res = await fetch(env.modalDownloadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Render-Secret": env.modalRenderSecret,
    },
    body: JSON.stringify({ url: String(sourceUrl) }),
  });

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try {
      detail = JSON.parse(raw)?.detail ?? raw;
    } catch {
      // Not JSON — keep the raw text as the detail.
    }
    throw new Error(`yt-dlp downloader failed (${res.status}): ${String(detail).slice(0, 500)}`);
  }

  await pipeline(Readable.fromWeb(res.body), createWriteStream(filePath));

  // Metadata headers from the downloader (best-effort, for logs only — the
  // pipeline still probes duration locally after the download).
  const durationHeader = Number(res.headers.get("x-video-duration"));
  const rawTitle = res.headers.get("x-video-title");
  const title = rawTitle ? decodeURIComponent(rawTitle) : null;
  if (title) console.log(`[modaldl] downloaded "${title}"`);
  return {
    filePath,
    duration: Number.isFinite(durationHeader) && durationHeader > 0 ? durationHeader : null,
    title,
  };
}