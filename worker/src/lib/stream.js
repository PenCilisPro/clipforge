import { env } from "./env.js";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/**
 * Cloudflare Stream — playback delivery layer for finalized clips.
 *
 * The render pipeline (FFmpeg + Shotstack) is unchanged; once the finished MP4
 * lands in R2 it is mirrored into Stream so the clip editor plays from
 * Cloudflare's CDN (adaptive HLS + progressive MP4) instead of R2 presigned
 * URLs. Playback URL signing lives in the backend (backend/src/lib/stream.js).
 *
 * Requires CLOUDFLARE_STREAM_API_TOKEN (a token with Stream:Edit permission)
 * and an account id (CLOUDFLARE_ACCOUNT_ID, falling back to R2_ACCOUNT_ID).
 * Optional CLOUDFLARE_STREAM_SIGNING_KEY/TOKEN enable signed playback URLs.
 */
export function streamConfigured() {
  return Boolean(env.cloudflareAccountId && env.streamApiToken);
}

function streamHeaders() {
  return {
    Authorization: `Bearer ${env.streamApiToken}`,
    "Content-Type": "application/json",
  };
}

function streamUrl(path) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/stream/${path}`;
}

function requireStreamConfigured() {
  if (!streamConfigured()) {
    throw new Error(
      "Cloudflare Stream is not configured — set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN"
    );
  }
}

/**
 * Upload a local MP4 to Stream via the direct-upload endpoint and return the
 * video UID. Videos created with requireSignedURLs=false are only reachable
 * by their unguessable UID-backed URLs.
 */
export async function uploadToStream(filePath, { name } = {}) {
  requireStreamConfigured();
  const requireSignedURLs = Boolean(env.streamSigningKey && env.streamSigningToken);

  const createRes = await fetch(streamUrl("direct_upload"), {
    method: "POST",
    headers: streamHeaders(),
    body: JSON.stringify({
      maxDurationSeconds: 43_200,
      requireSignedURLs,
      meta: { name: name ?? "clipforge-clip" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!createRes.ok) {
    throw new Error(`Stream direct upload creation failed (${createRes.status}): ${(await createRes.text()).slice(0, 300)}`);
  }
  const createData = await createRes.json();
  const { uploadURL, uid } = createData?.result ?? {};
  if (!uploadURL || !uid) throw new Error("Stream did not return an upload URL");

  const { stat } = await import("node:fs/promises");
  const { size } = await stat(filePath);
  const fileStream = Readable.toWeb(createReadStream(filePath));
  const uploadRes = await fetch(uploadURL, {
    method: "POST",
    body: fileStream,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
    },
    // Node's fetch requires duplex:"half" for stream bodies.
    duplex: "half",
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!uploadRes.ok) {
    throw new Error(`Stream file upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);
  }
  return { uid, requireSignedURLs };
}

/** Delete a Stream video (best-effort — used to clean up stale re-renders). */
export async function deleteStreamVideo(uid) {
  requireStreamConfigured();
  await fetch(streamUrl(encodeURIComponent(uid)), {
    method: "DELETE",
    headers: streamHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
}
