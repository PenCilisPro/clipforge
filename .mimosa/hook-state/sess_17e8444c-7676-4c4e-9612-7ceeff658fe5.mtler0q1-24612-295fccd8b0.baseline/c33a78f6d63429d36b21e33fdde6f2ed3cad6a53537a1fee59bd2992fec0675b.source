import { env } from "./env.js";

const BASE_URL = () =>
  env.shotstackEnv === "v1"
    ? "https://api.shotstack.io/v1"
    : `https://api.shotstack.io/${env.shotstackEnv}/`;

export const BRAND_HIGHLIGHT = "#FF5D1C";

/**
 * Caption style presets. The word highlight defaults to brand orange
 * (#FF5D1C). Shotstack's caption asset consumes an SRT/VTT file via `src`
 * and renders it with the given style. Fields mirror Shotstack's
 * CaptionStyle — tune names to the API version pinned by your account.
 */
const CAPTION_PRESETS = {
  classic: {
    style: "default",
    size: 42,
    colour: "#FFFFFF",
    outlineColour: "#000000",
    outline: 2,
    background: null,
    align: "center",
    valign: "bottom",
    wordHighlightColour: BRAND_HIGHLIGHT,
  },
  karaoke: {
    style: "karaoke",
    size: 48,
    colour: "#FFFFFF",
    outlineColour: "#000000",
    outline: 2,
    background: null,
    align: "center",
    valign: "bottom",
    wordHighlightColour: BRAND_HIGHLIGHT,
  },
  "bold-pop": {
    style: "boxed",
    size: 54,
    colour: "#FFFFFF",
    outlineColour: null,
    outline: 0,
    background: "#111111",
    align: "center",
    valign: "center",
    wordHighlightColour: BRAND_HIGHLIGHT,
  },
};

/**
 * Build the Shotstack "Edit" JSON payload:
 *  - 1080×1920 (9:16) output, video track cropped to fill
 *  - caption track from the clip-local SRT
 *  - optional watermark/logo overlay
 */
export function buildEditJson({ rawClipUrl, srtUrl, durationSeconds, captionStyle, watermarkUrl }) {
  const preset = CAPTION_PRESETS[captionStyle] ?? CAPTION_PRESETS.karaoke;

  const videoTrack = {
    clips: [
      {
        asset: {
          type: "video",
          src: rawClipUrl,
          volume: 1,
        },
        start: 0,
        length: durationSeconds,
        fit: "crop",
        scale: { x: 1, y: 1 },
        position: "center",
      },
    ],
  };

  const tracks = [videoTrack];

  if (watermarkUrl) {
    tracks.push({
      clips: [
        {
          asset: { type: "image", src: watermarkUrl },
          start: 0,
          length: durationSeconds,
          scale: 0.14,
          position: "topRight",
          offset: { x: -0.04, y: 0.04 },
          opacity: 0.9,
        },
      ],
    });
  }

  tracks.push({
    clips: [
      {
        asset: {
          type: "caption",
          src: srtUrl,
          style: preset,
        },
        start: 0,
        length: durationSeconds,
      },
    ],
  });

  return {
    timeline: {
      background: "#000000",
      fonts: [{ src: "https://fonts.cdnfonts.com/css/inter" }],
      tracks,
    },
    output: {
      format: "mp4",
      size: { width: 1080, height: 1920 },
      fps: 30,
    },
  };
}

const RENDER_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Render outputs may only be pulled from Shotstack-controlled hosts.
 * Used on every URL before the worker downloads a render (the webhook path
 * delivers this URL in a request body, so it must never be trusted blindly).
 */
export function assertTrustedRenderUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error("Shotstack render URL is malformed");
  }
  if (parsed.protocol !== "https:" || !/(^|\.)shotstack/i.test(parsed.hostname)) {
    throw new Error(`Refusing to download render from untrusted host: ${parsed.hostname}`);
  }
  return parsed.toString();
}

export async function submitRender(editJson, webhookUrl) {
  if (!env.shotstackApiKey) throw new Error("SHOTSTACK_API_KEY is not configured");

  const res = await fetch(`${BASE_URL()}render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.shotstackApiKey,
    },
    body: JSON.stringify({ ...editJson, webhook: webhookUrl ? { url: webhookUrl } : undefined }),
  });

  if (!res.ok) {
    throw new Error(`Shotstack render submit failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }

  const data = await res.json();
  const renderId = data?.response?.id;
  if (!renderId || !RENDER_ID_RE.test(String(renderId))) {
    throw new Error("Shotstack did not return a valid render id");
  }
  return String(renderId);
}

/** Poll-free design: render completion arrives via the Shotstack webhook
 * (backend /webhooks/shotstack → finalize stage). Nothing to poll here. */

/**
 * Download a finished render from Shotstack's CDN to a local path.
 * The URL is host-allowlisted — webhook-provided URLs are never trusted.
 */
export async function downloadRenderedClip(url, filePath) {
  const trusted = assertTrustedRenderUrl(url);
  const res = await fetch(trusted, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Failed to download rendered clip (${res.status})`);
  const { writeFile } = await import("node:fs/promises");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body), (await import("node:fs")).createWriteStream(filePath));
  return filePath;
}
