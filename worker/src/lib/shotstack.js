import { env } from "./env.js";
import { captionTrackClips, captionUnderlayClips, captionFont } from "./captions.js";

const BASE_URL = () =>
  env.shotstackEnv === "v1"
    ? "https://api.shotstack.io/v1"
    : `https://api.shotstack.io/${env.shotstackEnv}/`;

/**
 * Build the Shotstack "Edit" JSON payload.
 *
 * LAYERING (probe-verified against the stage API): the FIRST track in the
 * array renders TOPMOST — a full-screen video track covers anything after it.
 * Order is therefore top → bottom: captions, watermark, b-roll cutaways,
 * main talking-head video, background music (audio placement irrelevant).
 *
 * Captions are HTML text clips (native caption assets ignore timeline fonts
 * and accept no styling), so the chosen font's .ttf ships in timeline.fonts.
 * Each fonts[] entry must be exactly { src } — family/size/etc. are rejected
 * as unknown_property (stage API, probe-verified); the family name in the
 * caption HTML resolves via the .ttf's internal name.
 *
 * Cues carrying word timings render one clip per spoken word with the active
 * word accented (word-sync highlight); 250+ clips validated on stage.
 */
export function buildEditJson({
  rawClipUrl,
  durationSeconds,
  watermarkUrl,
  brollClips = [],
  musicTrack = null,
  captionCues = [],
  captionFontKey = "anton",
  captionStyle = "classic",
  captionStroke = false,
  captionShadow = false,
  captionStrokeColor = "#000000",
  captionStrokeSize = 4,
  captionShadowColor = "#000000",
  captionShadowSize = 6,
}) {
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
        position: "center",
      },
    ],
  };

  // Top → bottom: captions first so nothing can cover them.
  const tracks = [];

  const captionClips = captionTrackClips(captionCues, {
    fontKey: captionFontKey,
    style: captionStyle,
  });
  if (captionClips.length > 0) {
    tracks.push({ clips: captionClips });
  }

  // Stroke/shadow = underlay tracks beneath the captions (the renderer
  // ignores text-shadow/-webkit-text-stroke, so the effects are identical
  // text copies offset per clip). 4 directional copies form the outline,
  // one translucent shifted copy forms the shadow. Offsets scale with the
  // user-chosen size (1-10); size 4 ≈ the original fixed 0.0045 outline.
  if (captionClips.length > 0 && captionStroke) {
    const offset = 0.0011 * captionStrokeSize;
    const dirs = [
      [offset, 0],
      [-offset, 0],
      [0, offset],
      [0, -offset],
    ];
    for (const [dx, dy] of dirs) {
      const clips = captionUnderlayClips(captionCues, {
        fontKey: captionFontKey,
        style: captionStyle,
        dx,
        dy,
        color: captionStrokeColor,
      });
      if (clips.length > 0) tracks.push({ clips });
    }
  }
  if (captionClips.length > 0 && captionShadow) {
    const offset = 0.001 * captionShadowSize;
    const clips = captionUnderlayClips(captionCues, {
      fontKey: captionFontKey,
      style: captionStyle,
      dx: offset,
      dy: offset,
      color: captionShadowColor,
      opacity: 0.55,
    });
    if (clips.length > 0) tracks.push({ clips });
  }

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

  if (brollClips.length > 0) {
    tracks.push({
      clips: brollClips.slice(0, 6).map((b) => ({
        asset: { type: "video", src: b.src, volume: 0 },
        start: Math.max(0, Number(b.start)),
        // Trim the last b-roll so it can't overrun the clip.
        length: Math.min(Number(b.end) - Number(b.start), durationSeconds - Number(b.start)),
        fit: "crop",
        position: "center",
        transition: { in: "fade", out: "fade" },
      })),
    });
  }

  tracks.push(videoTrack);

  // Background music at ~15% of voiceover level (schema probe-validated).
  if (musicTrack?.url) {
    tracks.push({
      clips: [
        {
          asset: { type: "audio", src: musicTrack.url, volume: 0.15 },
          start: 0,
          length: durationSeconds,
        },
      ],
    });
  }

  return {
    timeline: {
      background: "#000000",
      fonts: [{ src: captionFont(captionFontKey).src }],
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

export async function submitRender(editJson, callbackUrl) {
  if (!env.shotstackApiKey) throw new Error("SHOTSTACK_API_KEY is not configured");

  // Completion callbacks ride at the payload root as a plain string URL.
  // Both a root-level `webhook` object and `output.webhook` are rejected by
  // the API (unknown_property 400) — `callback` is the only accepted form.
  const body = callbackUrl ? { ...editJson, callback: callbackUrl } : editJson;

  const res = await fetch(`${BASE_URL()}render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.shotstackApiKey,
    },
    body: JSON.stringify(body),
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
