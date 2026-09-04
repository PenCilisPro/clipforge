import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueuePipeline } from "../lib/queues.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const CAPTION_FONTS = ["anton", "bebas-neue", "archivo-black", "poppins"];

const regenerateSchema = z.object({
  caption_style: z.enum(["classic", "karaoke", "bold-pop"]),
  caption_font: z.enum(CAPTION_FONTS).optional(),
});

const editSchema = z.object({
  caption_style: z.enum(["classic", "karaoke", "bold-pop"]).optional(),
  caption_font: z.enum(CAPTION_FONTS).optional(),
  // Edited caption cues (clip-local SRT). Empty string clears a previous
  // override so the pipeline regenerates captions from the transcript.
  srt_content: z.string().max(20_000).optional(),
  start_time: z.coerce.number().finite().min(0).optional(),
  end_time: z.coerce.number().finite().min(3).max(43_200).optional(),
});

/** Signed playback URLs for the clip editor (final render if ready, else raw trim + SRT). */
router.get("/api/clips/:id/playback", requireAuth, async (req, res, next) => {
  try {
    const { data: clip, error } = await supabaseAdmin
      .from("clips")
      .select("id, storage_path, raw_clip_path, srt_path")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (error || !clip) return res.status(404).json({ error: "Clip not found" });

    const videoPath = clip.storage_path ?? clip.raw_clip_path;
    if (!videoPath) {
      return res.status(409).json({ error: "No video available yet — wait for the render." });
    }

    const [{ data: video }, srtResult] = await Promise.all([
      supabaseAdmin.storage.from("clips").createSignedUrl(videoPath, 60 * 60),
      clip.srt_path
        ? supabaseAdmin.storage.from("clips").createSignedUrl(clip.srt_path, 60 * 60)
        : Promise.resolve({ data: null }),
    ]);
    if (!video?.signedUrl) return res.status(500).json({ error: "Could not sign video URL" });

    res.json({
      video_url: video.signedUrl,
      srt_url: srtResult.data?.signedUrl ?? null,
      is_final_render: Boolean(clip.storage_path),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Edit a clip (caption text, caption style, timing) and re-render it.
 * Caption edits persist as `srt_override`; timing changes re-trim from the
 * source. Overrides are cleared when timing changes without new captions so
 * captions never desync from the new window.
 */
router.post("/api/clips/:id/edit", requireAuth, async (req, res, next) => {
  try {
    const body = editSchema.parse(req.body);

    const { data: clip, error: clipError } = await supabaseAdmin
      .from("clips")
      .select("id, project_id, start_time, end_time")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (clipError || !clip) return res.status(404).json({ error: "Clip not found" });

    const start = body.start_time ?? Number(clip.start_time);
    const end = body.end_time ?? Number(clip.end_time);
    if (end - start < 3) {
      return res.status(400).json({ error: "Clip must be at least 3 seconds long" });
    }
    const timingChanged =
      body.start_time !== undefined || body.end_time !== undefined;

    const updates = {
      status: "queued",
      error_message: null,
      storage_path: null,
      shotstack_render_id: null,
    };
    if (body.caption_style) updates.caption_style = body.caption_style;
    if (body.caption_font) updates.caption_font = body.caption_font;
    if (timingChanged) {
      updates.start_time = start;
      updates.end_time = end;
    }
    if (body.srt_content !== undefined) updates.srt_override = body.srt_content || null;
    else if (timingChanged) updates.srt_override = null;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("clips")
      .update(updates)
      .eq("id", clip.id)
      .select("*")
      .single();
    if (updateError) throw updateError;

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
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid edit" });
    }
    next(err);
  }
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
    // Failed clips may lack a raw trim (e.g. the trim itself OOM-killed) —
    // the render stage re-trims from the source, so they can retry safely.
    const canRetry = Boolean(clip.raw_clip_path) || clip.status === "failed";
    if (!canRetry) {
      return res
        .status(409)
        .json({ error: "Raw clip is not available yet — wait for the first render." });
    }

    const { data: updated, error } = await supabaseAdmin
      .from("clips")
      .update({
        caption_style: body.caption_style,
        ...(body.caption_font ? { caption_font: body.caption_font } : {}),
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
