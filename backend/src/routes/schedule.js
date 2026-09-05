import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueuePublish, removePublishJob } from "../lib/queues.js";
import { requireAuth } from "../middleware/auth.js";
import { isProOrAdmin } from "../lib/tiers.js";

const router = Router();

const createSchema = z.object({
  clip_id: z.string().uuid(),
  platform: z.enum(["youtube", "instagram", "tiktok", "facebook"]),
  connection_id: z.string().uuid().nullish(),
  caption_text: z.string().max(4000).nullish(),
  scheduled_time_utc: z.coerce.date(),
});

router.get("/api/schedule", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("scheduled_posts")
      .select("*, clips(title)")
      .eq("user_id", req.user.id)
      .order("scheduled_time_utc", { ascending: true });
    if (error) throw error;
    res.json({ posts: data });
  } catch (err) {
    next(err);
  }
});

router.post("/api/schedule", requireAuth, async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    if (body.scheduled_time_utc.getTime() < Date.now()) {
      return res.status(400).json({ error: "Scheduled time must be in the future" });
    }

    // Auto-scheduled uploads are a paid-plan/admin feature.
    if (!(await isProOrAdmin(req.user.id, req.user.email))) {
      return res.status(403).json({
        error:
          "Scheduled uploads need a Pro subscription — upgrade your plan or publish manually by downloading the clip.",
      });
    }

    // The clip must belong to the caller.
    const { data: clip } = await supabaseAdmin
      .from("clips")
      .select("id")
      .eq("id", body.clip_id)
      .eq("user_id", req.user.id)
      .single();
    if (!clip) return res.status(404).json({ error: "Clip not found" });

    // A connected account is required to auto-publish. The caller may pick a
    // specific channel; otherwise fall back to the earliest connection.
    let connectionId = body.connection_id ?? null;
    if (connectionId) {
      const { data: connection } = await supabaseAdmin
        .from("social_connections")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("id", connectionId)
        .eq("platform", body.platform)
        .single();
      if (!connection) {
        return res.status(400).json({
          error: `That ${body.platform} channel is not connected anymore.`,
        });
      }
    } else {
      const { data: connection } = await supabaseAdmin
        .from("social_connections")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("platform", body.platform)
        .order("connected_at", { ascending: true })
        .limit(1);
      if (!connection?.length) {
        return res.status(400).json({
          error: `Connect your ${body.platform} account first (Dashboard → Connections).`,
        });
      }
      connectionId = connection[0].id;
    }

    const { data: post, error } = await supabaseAdmin
      .from("scheduled_posts")
      .insert({
        user_id: req.user.id,
        clip_id: body.clip_id,
        platform: body.platform,
        social_connection_id: connectionId,
        caption_text: body.caption_text ?? null,
        scheduled_time_utc: body.scheduled_time_utc.toISOString(),
        status: "scheduled",
      })
      .select("*")
      .single();
    if (error) throw error;

    const job = await enqueuePublish(post.id, body.scheduled_time_utc.getTime());
    await supabaseAdmin
      .from("scheduled_posts")
      .update({ bullmq_job_id: String(job.id) })
      .eq("id", post.id);

    res.status(201).json({ post: { ...post, bullmq_job_id: String(job.id) } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid body" });
    }
    next(err);
  }
});

router.patch("/api/schedule/:id", requireAuth, async (req, res, next) => {
  try {
    const { data: post } = await supabaseAdmin
      .from("scheduled_posts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (!post) return res.status(404).json({ error: "Scheduled post not found" });
    if (post.status !== "scheduled") {
      return res.status(409).json({ error: `Post is already ${post.status}` });
    }

    const { action, scheduled_time_utc, caption_text } = req.body ?? {};

    if (action === "cancel") {
      await removePublishJob(post.bullmq_job_id);
      const { data, error } = await supabaseAdmin
        .from("scheduled_posts")
        .update({ status: "canceled" })
        .eq("id", post.id)
        .select("*")
        .single();
      if (error) throw error;
      return res.json({ post: data });
    }

    const updates = {};
    if (scheduled_time_utc) {
      const when = new Date(scheduled_time_utc);
      if (when.getTime() < Date.now()) {
        return res.status(400).json({ error: "Scheduled time must be in the future" });
      }
      await removePublishJob(post.bullmq_job_id);
      const job = await enqueuePublish(post.id, when.getTime());
      updates.scheduled_time_utc = when.toISOString();
      updates.bullmq_job_id = String(job.id);
    }
    if (typeof caption_text === "string") {
      updates.caption_text = caption_text;
    }

    const { data, error } = await supabaseAdmin
      .from("scheduled_posts")
      .update(updates)
      .eq("id", post.id)
      .select("*")
      .single();
    if (error) throw error;
    res.json({ post: data });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/schedule/:id", requireAuth, async (req, res, next) => {
  try {
    const { data: post } = await supabaseAdmin
      .from("scheduled_posts")
      .select("bullmq_job_id")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (!post) return res.status(404).json({ error: "Scheduled post not found" });
    await removePublishJob(post.bullmq_job_id);
    const { error } = await supabaseAdmin
      .from("scheduled_posts")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
