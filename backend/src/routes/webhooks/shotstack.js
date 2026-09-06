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
 * Shotstack render webhook.
 * Configure in the Shotstack dashboard (or per-render `webhook` field):
 *   URL:  {BACKEND_URL}/webhooks/shotstack
 * Shotstack sends the configured secret in `x-shotstack-webhook-secret`.
 * The worker also polls, so this handler is an optimization for instant UX:
 * on `done` it enqueues a finalize stage that downloads the MP4 and stores it
 * in Supabase Storage.
 */
router.post("/webhooks/shotstack", async (req, res) => {
  const provided =
    req.get("x-shotstack-webhook-secret") ?? req.query.secret ?? "";
  if (!secretMatches(provided, env.shotstackWebhookSecret)) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  const { id, status, url, error: renderError } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "Missing render id" });

  const { data: clip } = await supabaseAdmin
    .from("clips")
    .select("id, project_id, user_id")
    .eq("shotstack_render_id", id)
    .single();

  if (!clip) {
    // Unknown render — ack so Shotstack doesn't retry forever.
    return res.json({ ok: true, ignored: true });
  }

  if (status === "done" && url) {
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
  } else if (status === "failed") {
    await supabaseAdmin
      .from("clips")
      .update({ status: "failed", error_message: renderError ?? "Shotstack render failed" })
      .eq("id", clip.id);
  }

  res.json({ ok: true });
});

export default router;
