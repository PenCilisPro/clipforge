import crypto from "node:crypto";
import { env } from "./env.js";

/**
 * Modal render provider (https://modal.com) — serverless cloud, no watermark.
 *
 * The renderer itself is this repo's own ffmpeg pipeline: the Modal app in
 * `modal/modal_render.py` ships `localRender.js` into its image and runs it, so
 * the output is identical to RENDER_PROVIDER=local (same filtergraph, ASS
 * captions, 9:16 cover/contain layouts, watermark, music bed) without needing
 * encoding capacity on the worker. Modal's free plan includes $30/month of
 * compute, which is thousands of clips.
 *
 * Wire protocol (deliberately identical to Creatomate's, so pipelines need no
 * provider-specific branches):
 *   POST <base>/submit             → { renderId, clipId, spec, webhookUrl }
 *   GET  <base>/status/<renderId>  → { status: queued|rendering|done|failed }
 *   GET  <base>/download/<renderId>→ the finished MP4
 * Completion also arrives via the worker's webhook URL, which the Modal
 * function POSTs with the same { id, status, url, error_message } shape the
 * backend's /webhooks/render already handles.
 *
 * All three endpoints require the shared secret (X-Render-Secret).
 */

// Modal render ids are "modal-<uuid>" and clip ids are uuids.
const RENDER_ID_RE = /^[A-Za-z0-9-]+$/;

function modalBaseUrl() {
  const raw = String(env.modalRenderUrl ?? "").trim().replace(/\/+$/, "");
  if (!raw) {
    throw new Error("MODAL_RENDER_URL is not configured — deploy the Modal app and set its web URL");
  }
  if (/^https?:\/\/(?:www\.)?modal\.com/i.test(raw)) {
    throw new Error(
      `MODAL_RENDER_URL is pointing to "${raw}", which is the Modal web dashboard. It must be your deployed web endpoint ending in .modal.run (e.g. https://<workspace>--clipforge-render-web.modal.run)`
    );
  }
  return raw;
}

function modalSecret() {
  const secret = env.modalRenderSecret;
  if (!secret) throw new Error("MODAL_RENDER_SECRET is not configured");
  return secret;
}

/** The spec is already the worker's own render params (see localRender.js). */
export function buildRenderSpec(params) {
  return params;
}

export async function submitRender(spec, webhookUrl, meta = {}) {
  const clipId = String(meta.clipId ?? "");
  if (!RENDER_ID_RE.test(clipId)) throw new Error("Modal render requires a valid clipId");

  const renderId = `modal-${crypto.randomUUID()}`;
  const res = await fetch(`${modalBaseUrl()}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Render-Secret": modalSecret() },
    body: JSON.stringify({ renderId, clipId, spec, webhookUrl: webhookUrl ?? null }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(
      `Modal render submit failed (${res.status}): ${(await res.text()).slice(0, 300)}`
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) {
    throw new Error(`Modal render submit rejected: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return renderId;
}

/**
 * Poll a render. The webhook is the fast path; recovery.js/watchdog polls as a
 * fallback so a lost callback can't strand a finished clip. Statuses are
 * normalized to done | failed | rendering.
 */
export async function getRender(renderId) {
  if (!RENDER_ID_RE.test(String(renderId))) throw new Error("Invalid render id");

  const res = await fetch(`${modalBaseUrl()}/status/${encodeURIComponent(renderId)}`, {
    headers: { "X-Render-Secret": modalSecret() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Modal render poll failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  const raw = String(body?.status ?? "").toLowerCase();
  const status = raw === "done" ? "done" : raw === "failed" ? "failed" : "rendering";
  return {
    status,
    url: status === "done" ? `${modalBaseUrl()}/download/${encodeURIComponent(renderId)}` : null,
    error: body?.error ?? null,
  };
}

/**
 * Downloads may only come from this app's own /download/<id> path — the URL
 * arrives in a webhook body, so it is never trusted blindly.
 */
export function assertTrustedRenderUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error("Modal render URL is malformed");
  }
  const expectedHost = new URL(modalBaseUrl()).host;
  if (parsed.protocol !== "https:" || parsed.host !== expectedHost || !parsed.pathname.startsWith("/download/")) {
    throw new Error(`Refusing to download render from untrusted source: ${parsed.host}`);
  }
  return parsed.toString();
}

/** Stream a finished render from the Modal endpoint to a local path. */
export async function downloadRenderedClip(url, filePath) {
  const trusted = assertTrustedRenderUrl(url);
  const res = await fetch(trusted, {
    headers: { "X-Render-Secret": modalSecret() },
    redirect: "follow",
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!res.ok || !res.body) throw new Error(`Failed to download rendered clip (${res.status})`);
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body), (await import("node:fs")).createWriteStream(filePath));
  return filePath;
}
