import * as shotstack from "./shotstack.js";
import * as creatomate from "./creatomate.js";
import { env } from "./env.js";

/**
 * Render provider dispatcher. ClipForge renders clips remotely (the worker
 * container is too small for video encoding), and the provider is swappable:
 *
 *   RENDER_PROVIDER=creatomate | shotstack   (default: auto-detect)
 *
 * Auto-detect picks Creatomate when its key is set (watermark-free on every
 * plan), otherwise Shotstack (whose stage environment burns in a watermark —
 * kept as a legacy fallback only). Legacy in-flight renders are polled and
 * downloaded via the provider recorded on the clip row at submit time.
 */

const PROVIDERS = { shotstack, creatomate };

export function resolveRenderProvider() {
  const requested = String(env.renderProvider ?? "").trim().toLowerCase();
  if (requested === "creatomate" || requested === "shotstack") return requested;
  if (requested) {
    console.warn(`[render] Unknown RENDER_PROVIDER "${requested}" — auto-detecting from API keys`);
  }
  if (env.creatomateApiKey) return "creatomate";
  if (env.shotstackApiKey) return "shotstack";
  return "creatomate"; // nothing configured — submit will fail with the key error
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

export function submitRender(spec, callbackUrl) {
  return providerFor(null).submitRender(spec, callbackUrl);
}

/** Poll a render, optionally against a specific provider (legacy clips). */
export function getRender(renderId, providerName = null) {
  return providerFor(providerName).getRender(renderId);
}

/** Download a finished render, optionally from a specific provider's CDN. */
export function downloadRenderedClip(url, filePath, providerName = null) {
  return providerFor(providerName).downloadRenderedClip(url, filePath);
}
