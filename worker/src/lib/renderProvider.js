import * as shotstack from "./shotstack.js";
import * as creatomate from "./creatomate.js";
import * as local from "./localRender.js";
import { env } from "./env.js";

/**
 * Render provider dispatcher. ClipForge renders clips remotely (the worker
 * container is too small for video encoding), and the provider is swappable:
 *
 *   RENDER_PROVIDER=creatomate | shotstack | local   (default: auto-detect)
 *
 * Auto-detect picks Creatomate when its key is set (watermark-free on every
 * plan), otherwise Shotstack (whose stage environment burns in a watermark —
 * kept as a legacy fallback only), and falls back to "local" when no cloud
 * provider is configured: ffmpeg renders on the worker itself, so there are
 * no usage credits and no watermark at the cost of local CPU time. Legacy
 * in-flight renders are polled and downloaded via the provider recorded on
 * the clip row at submit time.
 */

const PROVIDERS = { shotstack, creatomate, local };

export function resolveRenderProvider() {
  const requested = String(env.renderProvider ?? "").trim().toLowerCase();
  if (requested === "creatomate" || requested === "shotstack" || requested === "local") return requested;
  if (requested) {
    console.warn(`[render] Unknown RENDER_PROVIDER "${requested}" — auto-detecting from API keys`);
  }
  if (env.creatomateApiKey) return "creatomate";
  if (env.shotstackApiKey) return "shotstack";
  return "local"; // nothing configured — render on the worker itself
}

export function renderProviderName() {
  return resolveRenderProvider();
}

function providerFor(name) {
  const key = name === "shotstack" || name === "creatomate" ? name : resolveRenderProvider();
  return PROVIDERS[key];
}

export function buildRenderSpec(params) {
  return providerFor(null).buildRenderSpec(params);
}

export function submitRender(spec, callbackUrl, meta = {}) {
  // meta carries { clipId } — only the local provider needs it; the cloud
  // providers ignore extra arguments.
  return providerFor(null).submitRender(spec, callbackUrl, meta);
}

/** Poll a render, optionally against a specific provider (legacy clips). */
export function getRender(renderId, providerName = null) {
  return providerFor(providerName).getRender(renderId);
}

/** Download a finished render, optionally from a specific provider's CDN. */
export function downloadRenderedClip(url, filePath, providerName = null) {
  return providerFor(providerName).downloadRenderedClip(url, filePath);
}
