import { createHmac } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Cloudflare Stream — playback delivery for finalized clips.
 *
 * Finalized MP4s live in R2 (source of truth) and are mirrored into Stream by
 * the worker (worker/src/lib/stream.js). This module checks mirror status and
 * builds the playback URL the clip editor plays: the progressive MP4 from
 * Stream's CDN, signed with a short-lived JWT when the video requires it.
 *
 * Optional config: CLOUDFLARE_STREAM_API_TOKEN (Stream:Edit), plus
 * CLOUDFLARE_STREAM_SIGNING_KEY + CLOUDFLARE_STREAM_SIGNING_TOKEN for signed
 * playback (the pair uploaded videos as requireSignedURLs=true).
 */
export function streamConfigured() {
  return Boolean(env.cloudflareAccountId && env.streamApiToken);
}

function streamUrl(path) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/stream/${path}`;
}

/**
 * Fetch a Stream video's status. Returns null when the mirror is missing or
 * Stream isn't configured — callers fall back to R2 presigned playback.
 */
export async function getStreamVideo(uid) {
  if (!streamConfigured()) return null;
  try {
    const res = await fetch(streamUrl(`${encodeURIComponent(uid)}`), {
      headers: { Authorization: `Bearer ${env.streamApiToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data?.result;
    if (!v || v.state === "error" || v.status?.state === "error") return null;
    const ready = v.readyToStream || v.status?.state === "ready";
    return {
      ready: Boolean(ready),
      playbackUrls: Array.isArray(v.playback?.urls) ? v.playback.urls : [],
      requireSignedURLs: Boolean(v.requireSignedURLs),
    };
  } catch {
    return null;
  }
}

/** Pick the progressive MP4 from Stream's playback URLs (falls back to HLS). */
function pickPlaybackUrl(playbackUrls) {
  const mp4 = playbackUrls.find((u) => typeof u === "string" && u.endsWith("/downloads/default.mp4"));
  if (mp4) return mp4;
  const hls = playbackUrls.find((u) => typeof u === "string" && u.includes("/manifest/video.m3u8"));
  if (hls) return hls;
  return playbackUrls.find((u) => typeof u === "string") ?? null;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign a Stream playback token (HS256 JWT, kid = signing token) —
 * https://developers.cloudflare.com/stream/getting-started/concepts/#signed-urls
 */
function signStreamToken(uid, expiresInSec) {
  const header = b64url(JSON.stringify({ alg: "HS256", kid: env.streamSigningToken }));
  const payload = b64url(
    JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + expiresInSec })
  );
  const signature = createHmac("sha256", env.streamSigningKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Resolve the playback URL for a finalized clip.
 * Returns { url, signed: boolean } or null when no Stream playback is
 * available (caller falls back to the R2 presigned URL).
 */
export async function streamPlaybackUrl(uid, expiresInSec = 60 * 60 * 4) {
  const video = await getStreamVideo(uid);
  if (!video?.ready) return null;
  const base = pickPlaybackUrl(video.playbackUrls);
  if (!base) return null;
  if (!video.requireSignedURLs) return { url: base, signed: false };
  if (!env.streamSigningKey || !env.streamSigningToken) return null;
  const origin = new URL(base).origin;
  const url = `${origin}/downloads/default.mp4`;
  return { url: `${url}?token=${signStreamToken(uid, expiresInSec)}`, signed: true };
}
