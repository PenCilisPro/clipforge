import { Router } from "express";
import crypto from "node:crypto";
import { supabaseAdmin } from "../../lib/supabase.js";
import { enqueuePipeline } from "../../lib/queues.js";
import { env } from "../../config/env.js";

const router = Router();

/** Constant-time secret compare (hash first so lengths always match). */
function secretMatches(provided, expected) {
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(String(provided)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Render webhook — provider-agnostic receiver for render completion
 * callbacks. The worker appends the shared secret to each render's
 * `webhook_url`/`callback` (?secret=...), which arrives here on:
 *   /webhooks/render     (current providers, e.g. Creatomate)
 *   /webhooks/shotstack  (legacy path kept for in-flight renders)
 *
 * Payloads differ slightly by provider and both are accepted:
 *   Shotstack: { id, status: "done"|"failed", url, error: {message}|string }
 *   Creatomate: { id, status: "succeeded"|"failed"|"cancelled", url,
 *                 error_message: "..." }
 *
 * On success this enqueues a finalize stage that downloads the MP4 and
 * stores it in R2; the worker also polls, so this handler is an
 * optimization for instant UX, not the only completion path.
 */
const DONE_STATUSES = new Set(["done", "succeeded"]);
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled"]);

async function handleRenderWebhook(req, res) {
  const provided =
    req.get("x-shotstack-webhook-secret") ?? req.get("x-creatomate-signature") ?? req.query.secret ?? "";
  if (!secretMatches(provided, env.renderWebhookSecret)) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  const { id, status, url } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "Missing render id" });

  const renderError =
    req.body?.error_message ??
    (typeof req.body?.error === "string" ? req.body.error : req.body?.error?.message) ??
    null;

  // New clips carry render_id; legacy Shotstack rows only have the old field.
  let { data: clip } = await supabaseAdmin
    .from("clips")
    .select("id, project_id, user_id")
    .eq("render_id", id)
    .maybeSingle();
  if (!clip) {
    ({ data: clip } = await supabaseAdmin
      .from("clips")
      .select("id, project_id, user_id")
      .eq("shotstack_render_id", id)
      .maybeSingle());
  }

  if (!clip) {
    // Unknown render — ack so the provider doesn't retry forever.
    return res.json({ ok: true, ignored: true });
  }

  const normalized = String(status ?? "").toLowerCase();
  if (DONE_STATUSES.has(normalized) && url) {
    await supabaseAdmin
      .from("clips")
      .update({ status: "rendering" })
      .eq("id", clip.id);
    // No new job row here — the worker's finalize stage completes the clip's
    // existing active `render` row (keeps the dashboard pipeline honest).
    await enqueuePipeline(
      "finalize",
      { projectId: clip.project_id, clipId: clip.id, renderUrl: url, jobRowId: null },
      { attempts: 5 }
    );
  } else if (FAILED_STATUSES.has(normalized)) {
    await supabaseAdmin
      .from("clips")
      .update({ status: "failed", error_message: renderError ?? "Render failed" })
      .eq("id", clip.id);
  }

  res.json({ ok: true });
}

router.post("/webhooks/render", handleRenderWebhook);
router.post("/webhooks/shotstack", handleRenderWebhook);

export default router;
