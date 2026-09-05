import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueuePipeline } from "../lib/queues.js";
import { requireAuth } from "../middleware/auth.js";
import { isProOrAdmin } from "../lib/tiers.js";
import { ensureMonthlyCredits } from "../lib/credits.js";

const router = Router();

const CLIP_LENGTH_PREFS = ["10-14", "15-30", "31-45", "60+", "ai_optimized"];
// Tiers above "1-5" require a paid plan (pro/business) or an admin account.
const CLIP_COUNT_TIERS = ["1-5", "6-10", "11-15"];
const MUSIC_MOODS = [
  "upbeat", "chill", "dramatic", "corporate", "energetic", "happy", "epic", "background",
];

const createSchema = z
  .object({
    source_type: z.enum(["url", "upload"]),
    source_url: z.string().url().optional(),
    storage_path: z.string().min(1).optional(),
    title: z.string().max(200).nullish(),
    clip_length_pref: z.enum(CLIP_LENGTH_PREFS).default("ai_optimized"),
    clip_count_tier: z.enum(CLIP_COUNT_TIERS).default("1-5"),
    music_url: z
      .string()
      .url()
      .refine((u) => {
        try {
          return new URL(u).hostname.endsWith("jamendo.com");
        } catch {
          return false;
        }
      })
      .optional(),
    music_title: z.string().trim().max(200).optional(),
    music_artist: z.string().trim().max(200).optional(),
    music_mood: z.enum(MUSIC_MOODS).optional(),
  })
  .refine((data) => data.source_type === "upload" || !!data.source_url, {
    message: "source_url is required for url projects",
  })
  .refine((data) => data.source_type === "url" || !!data.storage_path, {
    message: "storage_path is required for upload projects",
  })
  .refine((data) => !data.music_url || (!!data.music_title && !!data.music_mood), {
    message: "music_title and music_mood are required with music_url",
  });

async function insertJobRow(projectId, jobType, clipId = null) {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .insert({ project_id: projectId, clip_id: clipId, job_type: jobType, status: "queued" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

router.post("/api/projects", requireAuth, async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);

    // Clip-count gate: tiers above 1-5 are a paid-plan/admin feature.
    if (body.clip_count_tier !== "1-5") {
      if (!(await isProOrAdmin(req.user.id, req.user.email))) {
        return res.status(403).json({
          error:
            "More than 5 clips per video needs a Pro subscription — upgrade your plan or pick 1-5 clips.",
        });
      }
    }

    // Credit gate: block new work when the user is out of credits.
    // (Monthly plan allotments are applied first when due.)
    await ensureMonthlyCredits(req.user.id);
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("credits_remaining")
      .eq("id", req.user.id)
      .single();
    if (!profile || Number(profile.credits_remaining) <= 0) {
      return res
        .status(402)
        .json({ error: "Out of credits — upgrade your plan to keep forging clips." });
    }

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .insert({
        user_id: req.user.id,
        title: body.title ?? null,
        source_url: body.source_url ?? null,
        source_type: body.source_type,
        original_video_path: body.storage_path ?? null,
        status: "pending",
        clip_length_pref: body.clip_length_pref,
        clip_count_tier: body.clip_count_tier,
        music_url: body.music_url ?? null,
        music_title: body.music_title ?? null,
        music_artist: body.music_artist ?? null,
        music_mood: body.music_mood ?? null,
      })
      .select("*")
      .single();
    if (error) throw error;

    // Uploads go straight to transcription; URLs start with download.
    const firstStage = body.source_type === "upload" ? "transcribe" : "download";
    const jobRowId = await insertJobRow(project.id, firstStage);
    await enqueuePipeline(firstStage, { projectId: project.id, jobRowId });

    res.status(201).json({ project });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid body" });
    }
    next(err);
  }
});

router.get("/api/projects", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .select("*, clips(count)")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ projects: data });
  } catch (err) {
    next(err);
  }
});

router.get("/api/projects/:id", requireAuth, async (req, res, next) => {
  try {
    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("*, clips(*), jobs(*)")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (error) return res.status(404).json({ error: "Project not found" });
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

/** Manually set the project's background music (free — no AI, no credits).
 *  Two sources: a Jamendo search result (music_url) or the user's own MP3
 *  already uploaded to the user-uploads bucket (music_storage_path). */
router.post("/api/projects/:id/music", requireAuth, async (req, res, next) => {
  try {
    const trackSchema = z.union([
      z.object({
        music_url: z
          .string()
          .url()
          .refine((u) => {
            try {
              return new URL(u).hostname.endsWith("jamendo.com");
            } catch {
              return false;
            }
          }),
        music_title: z.string().trim().min(1).max(200),
        music_artist: z.string().trim().max(200).optional(),
        music_mood: z.enum(MUSIC_MOODS),
      }),
      z.object({
        music_storage_path: z
          .string()
          .min(1)
          .refine((p) => p.startsWith(`${req.user.id}/music/`), {
            message: "Invalid music file",
          }),
        music_title: z.string().trim().min(1).max(200),
        music_artist: z.string().trim().max(200).optional(),
        music_mood: z.enum(MUSIC_MOODS),
      }),
    ]);
    const body = trackSchema.parse(req.body);

    // Uploaded tracks must actually exist and belong to the caller.
    if ("music_storage_path" in body) {
      const { data: obj, error: objError } = await supabaseAdmin.storage
        .from("user-uploads")
        .list(body.music_storage_path.split("/").slice(0, -1).join("/"), {
          search: body.music_storage_path.split("/").pop(),
          limit: 1,
        });
      if (objError || !obj || obj.length === 0) {
        return res.status(400).json({ error: "Uploaded music file not found" });
      }
    }

    const { data: project, error: projectError } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (projectError || !project) return res.status(404).json({ error: "Project not found" });

    const { data: updated, error } = await supabaseAdmin
      .from("projects")
      .update({
        music_url: body.music_url ?? null,
        music_storage_path: body.music_storage_path ?? null,
        music_title: body.music_title,
        music_artist: body.music_artist ?? null,
        music_mood: body.music_mood,
      })
      .eq("id", project.id)
      .select("id, music_url, music_storage_path, music_title, music_artist, music_mood")
      .single();
    if (error) throw error;
    res.json({ music: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid music track" });
    }
    next(err);
  }
});

router.delete("/api/projects/:id", requireAuth, async (req, res, next) => {
  try {
    const projectId = req.params.id;

    // Grab every storage path the project owns before the row (and its
    // cascaded clips) disappears, then best-effort remove the objects so the
    // buckets don't accumulate orphans. Storage failures never block deletion.
    const [{ data: project }, { data: clips }] = await Promise.all([
      supabaseAdmin
        .from("projects")
        .select("original_video_path")
        .eq("id", projectId)
        .eq("user_id", req.user.id)
        .single(),
      supabaseAdmin
        .from("clips")
        .select("raw_clip_path, srt_path, storage_path, thumbnail_path")
        .eq("project_id", projectId)
        .eq("user_id", req.user.id),
    ]);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const byBucket = {
      "source-videos": [project.original_video_path],
      clips: (clips ?? []).flatMap((c) => [c.raw_clip_path, c.srt_path, c.storage_path]),
      assets: (clips ?? []).map((c) => c.thumbnail_path),
    };
    await Promise.all(
      Object.entries(byBucket).map(([bucket, paths]) => {
        const objects = paths.filter(Boolean);
        if (objects.length === 0) return Promise.resolve();
        return supabaseAdmin.storage
          .from(bucket)
          .remove(objects)
          .catch(() => {});
      })
    );

    // DB rows go by cascade: clips → jobs / scheduled_posts.
    const { error } = await supabaseAdmin
      .from("projects")
      .delete()
      .eq("id", projectId)
      .eq("user_id", req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
