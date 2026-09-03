import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueuePipeline } from "../lib/queues.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const regenerateSchema = z.object({
  caption_style: z.enum(["classic", "karaoke", "bold-pop"]),
});

/**
 * Re-render a clip with a new caption style.
 * Resets the clip to `queued`, logs a render job and enqueues the stage.
 */
router.post("/api/clips/:id/regenerate", requireAuth, async (req, res, next) => {
  try {
    const body = regenerateSchema.parse(req.body);

    const { data: clip, error: clipError } = await supabaseAdmin
      .from("clips")
      .select("id, project_id, user_id, status")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (clipError || !clip) {
      return res.status(404).json({ error: "Clip not found" });
    }
    if (!clip.raw_clip_path && clip.status !== "ready") {
      return res
        .status(409)
        .json({ error: "Raw clip is not available yet — wait for the first render." });
    }

    const { data: updated, error } = await supabaseAdmin
      .from("clips")
      .update({
        caption_style: body.caption_style,
        status: "queued",
        error_message: null,
        // Clear the previous render so the render stage re-processes the clip
        // instead of treating it as already finalized.
        storage_path: null,
        shotstack_render_id: null,
      })
      .eq("id", clip.id)
      .select("*")
      .single();
    if (error) throw error;

    // Reuse the existing raw trim + SRT: jump straight to render.
    const { data: jobRow, error: jobError } = await supabaseAdmin
      .from("jobs")
      .insert({
        project_id: clip.project_id,
        clip_id: clip.id,
        job_type: "render",
        status: "queued",
      })
      .select("id")
      .single();
    if (jobError) throw jobError;

    await enqueuePipeline("render", {
      projectId: clip.project_id,
      clipId: clip.id,
      jobRowId: jobRow.id,
    });

    res.json({ clip: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid caption_style" });
    }
    next(err);
  }
});

export default router;
