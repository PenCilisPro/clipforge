import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueuePipeline } from "../lib/queues.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const createSchema = z
  .object({
    source_type: z.enum(["url", "upload"]),
    source_url: z.string().url().optional(),
    storage_path: z.string().min(1).optional(),
    title: z.string().max(200).nullish(),
  })
  .refine((data) => data.source_type === "upload" || !!data.source_url, {
    message: "source_url is required for url projects",
  })
  .refine((data) => data.source_type === "url" || !!data.storage_path, {
    message: "storage_path is required for upload projects",
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

    // Credit gate: block new work when the user is out of credits.
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
