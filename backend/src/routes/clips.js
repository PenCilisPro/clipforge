import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueuePipeline } from "../lib/queues.js";
import { requireAuth } from "../middleware/auth.js";
import {
  aiConfigured,
  brollConfigured,
  planBrollSegments,
  pickMusicMood,
  searchStockClips,
} from "../lib/aiEnhance.js";
import { fetchCatalog } from "./music.js";

const router = Router();

const CAPTION_STYLES = ["classic", "karaoke", "bold-pop", "neon", "meme"];
const CAPTION_FONTS = [
  "anton",
  "bebas-neue",
  "archivo-black",
  "poppins",
  "bangers",
  "luckiest-guy",
  "titan-one",
  "russo-one",
  "righteous",
  "permanent-marker",
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const effectShape = {
  caption_stroke: z.boolean().optional(),
  caption_shadow: z.boolean().optional(),
  caption_stroke_color: z.string().regex(HEX_COLOR).optional(),
  caption_stroke_size: z.coerce.number().int().min(1).max(10).optional(),
  caption_shadow_color: z.string().regex(HEX_COLOR).optional(),
  caption_shadow_size: z.coerce.number().int().min(1).max(10).optional(),
};

const regenerateSchema = z.object({
  caption_style: z.enum(CAPTION_STYLES),
  caption_font: z.enum(CAPTION_FONTS).optional(),
  ...effectShape,
});

const editSchema = z.object({
  caption_style: z.enum(CAPTION_STYLES).optional(),
  caption_font: z.enum(CAPTION_FONTS).optional(),
  ...effectShape,
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
    if (body.caption_stroke !== undefined) updates.caption_stroke = body.caption_stroke;
    if (body.caption_shadow !== undefined) updates.caption_shadow = body.caption_shadow;
    for (const key of [
      "caption_stroke_color",
      "caption_stroke_size",
      "caption_shadow_color",
      "caption_shadow_size",
    ]) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
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
        ...(body.caption_stroke !== undefined ? { caption_stroke: body.caption_stroke } : {}),
        ...(body.caption_shadow !== undefined ? { caption_shadow: body.caption_shadow } : {}),
        ...(body.caption_stroke_color ? { caption_stroke_color: body.caption_stroke_color } : {}),
        ...(body.caption_stroke_size ? { caption_stroke_size: body.caption_stroke_size } : {}),
        ...(body.caption_shadow_color ? { caption_shadow_color: body.caption_shadow_color } : {}),
        ...(body.caption_shadow_size ? { caption_shadow_size: body.caption_shadow_size } : {}),
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

const MUSIC_MOODS = [
  "upbeat", "chill", "dramatic", "corporate", "energetic", "happy", "epic", "background",
];

/** Every AI generation from the clip editor costs this many credits. */
const AI_CREDIT_COST = 10;

/** Load a user-owned clip together with its project transcript. */
async function loadClipWithProject(clipId, userId) {
  const { data: clip, error } = await supabaseAdmin
    .from("clips")
    .select("id, project_id, start_time, end_time, projects(id, transcript_json)")
    .eq("id", clipId)
    .eq("user_id", userId)
    .single();
  return { clip, error };
}

/** Gate + atomic spend. Returns the new balance or null when unaffordable. */
async function spendCredits(userId, res) {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("credits_remaining")
    .eq("id", userId)
    .single();
  if (!profile || Number(profile.credits_remaining) < AI_CREDIT_COST) {
    res.status(402).json({
      error: `Not enough credits — an AI generation costs ${AI_CREDIT_COST} credits.`,
    });
    return null;
  }
  const { data: left, error } = await supabaseAdmin.rpc("deduct_credits", {
    p_user_id: userId,
    p_amount: AI_CREDIT_COST,
  });
  if (error) throw error;
  if (left == null) {
    res.status(402).json({
      error: `Not enough credits — an AI generation costs ${AI_CREDIT_COST} credits.`,
    });
    return null;
  }
  return left;
}

/**
 * Generate B-roll for a clip with AI (LLM plans the segments, Pexels/Pixabay
 * resolve them to stock clips). The plan is stored on the clip and used
 * verbatim at render time. Costs AI_CREDIT_COST credits on success.
 */
router.post("/api/clips/:id/broll/ai", requireAuth, async (req, res, next) => {
  try {
    if (!aiConfigured() || !brollConfigured()) {
      return res.status(501).json({ error: "AI b-roll is not configured yet." });
    }
    const { clip, error: clipError } = await loadClipWithProject(req.params.id, req.user.id);
    if (clipError || !clip) return res.status(404).json({ error: "Clip not found" });

    const start = Number(clip.start_time);
    const end = Number(clip.end_time);
    const segments = await planBrollSegments({
      transcriptJson: clip.projects?.transcript_json,
      clipStart: start,
      clipEnd: end,
      durationSeconds: end - start,
    });

    const left = await spendCredits(req.user.id, res);
    if (left == null) return;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("clips")
      .update({ broll_json: segments })
      .eq("id", clip.id)
      .select("id, broll_json")
      .single();
    if (updateError) throw updateError;

    res.json({ broll: segments, credits_remaining: left });
  } catch (err) {
    next(err);
  }
});

/**
 * Set the clip's B-roll mode without spending credits: "auto" (plan fresh
 * with AI at render time) or "none" (explicitly no B-roll).
 */
router.post("/api/clips/:id/broll", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({ mode: z.enum(["auto", "none"]) }).parse(req.body);
    const { data: clip, error: clipError } = await supabaseAdmin
      .from("clips")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (clipError || !clip) return res.status(404).json({ error: "Clip not found" });

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("clips")
      .update({ broll_json: body.mode === "auto" ? null : [] })
      .eq("id", clip.id)
      .select("id, broll_json")
      .single();
    if (updateError) throw updateError;
    res.json({ broll_json: updated.broll_json });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid b-roll mode" });
    }
    next(err);
  }
});

/**
 * Pick background music for the clip's project with AI (LLM chooses the
 * mood from the transcript, Jamendo supplies the catalog). Updates the
 * project's music — applies on the next re-render. Costs credits.
 */
router.post("/api/clips/:id/music/ai", requireAuth, async (req, res, next) => {
  try {
    if (!aiConfigured()) {
      return res.status(501).json({ error: "AI music picking is not configured yet." });
    }
    const { clip, error: clipError } = await loadClipWithProject(req.params.id, req.user.id);
    if (clipError || !clip) return res.status(404).json({ error: "Clip not found" });

    const start = Number(clip.start_time);
    const end = Number(clip.end_time);
    const words = (clip.projects?.transcript_json?.words ?? []).filter(
      (w) => Number(w.end) > start && Number(w.start) < end
    );
    const transcriptText = words.map((w) => w.word).join(" ");
    if (!transcriptText.trim()) {
      return res.status(409).json({ error: "No transcript available for this clip yet." });
    }

    // AI mood picking is best-effort: fall back to a random mood instead of
    // failing the whole request when the model errors or returns junk.
    let mood;
    try {
      mood = await pickMusicMood({ transcriptText, moods: MUSIC_MOODS });
    } catch (err) {
      console.warn("AI mood pick failed, using fallback:", err?.message ?? err);
      mood = MUSIC_MOODS[Math.floor(Math.random() * MUSIC_MOODS.length)];
    }
    let catalog;
    try {
      catalog = await fetchCatalog();
    } catch (err) {
      console.error("Music catalog fetch failed:", err?.message ?? err);
      return res.status(502).json({ error: "The music catalog is unavailable right now." });
    }
    const matching = catalog.filter((t) => t.tags.includes(mood));
    const pool = matching.length > 0 ? matching : catalog;
    const track = pool.find((t) => t.duration >= end - start) ?? pool[0];
    if (!track) {
      return res.status(502).json({ error: "The music catalog is unavailable right now." });
    }

    const left = await spendCredits(req.user.id, res);
    if (left == null) return;

    const { error: updateError } = await supabaseAdmin
      .from("projects")
      .update({
        music_url: track.audio,
        music_title: track.name,
        music_artist: track.artist,
        music_mood: mood,
      })
      .eq("id", clip.project_id);
    if (updateError) throw updateError;

    res.json({
      track: { name: track.name, artist: track.artist, audio: track.audio, mood },
      credits_remaining: left,
    });
  } catch (err) {
    next(err);
  }
});

/** Keyword/category stock-footage search for the editor's b-roll picker (free). */
router.get("/api/clips/:id/broll/search", requireAuth, async (req, res, next) => {
  try {
    if (!brollConfigured()) {
      return res.status(501).json({ error: "Stock footage is not configured yet." });
    }
    const q = z.string().trim().min(2).max(80).parse(String(req.query.q ?? ""));
    const results = await searchStockClips(q);
    res.json({ query: q, results });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Search needs a keyword (2-80 chars)" });
    }
    next(err);
  }
});

const brollSegmentSchema = z.object({
  segments: z
    .array(
      z.object({
        start: z.coerce.number().finite().min(0).max(43_200),
        end: z.coerce.number().finite().min(0).max(43_200),
        src: z
          .string()
          .url()
          .refine((u) => {
            try {
              const host = new URL(u).hostname;
              return (
                u.startsWith("https:") &&
                (host === "pexels.com" || host.endsWith(".pexels.com") ||
                 host === "pixabay.com" || host.endsWith(".pixabay.com"))
              );
            } catch {
              return false;
            }
          }, { message: "B-roll URLs must come from the stock providers" }),
      })
      .refine((s) => s.end > s.start, { message: "Segment end must be after its start" })
      .transform((s) => ({ start: s.start, end: s.end, src: s.src }))
    )
    .max(8),
});

/** Replace the clip's manually-curated b-roll segments (free). */
router.post("/api/clips/:id/broll/segments", requireAuth, async (req, res, next) => {
  try {
    const body = brollSegmentSchema.parse(req.body);
    const { data: clip, error: clipError } = await supabaseAdmin
      .from("clips")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (clipError || !clip) return res.status(404).json({ error: "Clip not found" });

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("clips")
      .update({ broll_json: body.segments })
      .eq("id", clip.id)
      .select("id, broll_json")
      .single();
    if (updateError) throw updateError;
    res.json({ broll: updated.broll_json });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid segments" });
    }
    next(err);
  }
});

export default router;
