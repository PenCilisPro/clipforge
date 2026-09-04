import express, { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";

const router = Router();

// Logo uploads arrive as base64 JSON — allow a bigger body on this one route
// than the global 1mb JSON limit.
const brandingParser = express.json({ limit: "3mb" });

router.use("/api/admin", requireAuth, requireAdmin);/**
 * All users with basic activity counts. PostgREST can't embed
 * profiles→projects (both FK into auth.users, not each other), so counts are
 * aggregated in JS — fine at this product's scale.
 */
router.get("/api/admin/users", async (req, res, next) => {
  try {
    const [{ data: profiles, error: profilesError }, { data: projects }, { data: clips }] =
      await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select("id, email, display_name, avatar_url, plan, credits_remaining, created_at")
          .order("created_at", { ascending: false }),
        supabaseAdmin.from("projects").select("user_id"),
        supabaseAdmin.from("clips").select("user_id"),
      ]);
    if (profilesError) throw profilesError;

    const projectCounts = countBy(projects ?? [], "user_id");
    const clipCounts = countBy(clips ?? [], "user_id");

    res.json({
      users: (profiles ?? []).map((p) => ({
        ...p,
        project_count: projectCounts.get(p.id) ?? 0,
        clip_count: clipCounts.get(p.id) ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const creditsSchema = z.object({
  credits: z.coerce
    .number()
    .finite()
    .min(0, "Credits cannot be negative")
    .max(1_000_000, "Credits must be under 1,000,000"),
});

/** Set a user's credits to an absolute value. */
router.patch("/api/admin/users/:id/credits", async (req, res, next) => {
  try {
    const { credits } = creditsSchema.parse(req.body);

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .update({ credits_remaining: credits })
      .eq("id", req.params.id)
      .select("id, email, display_name, plan, credits_remaining, created_at")
      .single();
    if (error) throw error;

    res.json({ user: data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid credits value" });
    }
    next(err);
  }
});

/** Latest feedback with author info. */
router.get("/api/admin/feedback", async (req, res, next) => {
  try {
    const { data: feedback, error } = await supabaseAdmin
      .from("feedback")
      .select("id, user_id, message, category, rating, contact_email, screenshot_path, admin_reply, admin_replied_at, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const authorIds = [...new Set((feedback ?? []).map((f) => f.user_id))];
    const { data: authors } = authorIds.length
      ? await supabaseAdmin
          .from("profiles")
          .select("id, email, display_name")
          .in("id", authorIds)
      : { data: [] };
    const byId = new Map((authors ?? []).map((a) => [a.id, a]));

    res.json({
      feedback: (feedback ?? []).map((f) => ({
        ...f,
        email: byId.get(f.user_id)?.email ?? null,
        display_name: byId.get(f.user_id)?.display_name ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const replySchema = z.object({
  reply: z.string().trim().min(1, "Reply cannot be empty").max(4000),
});

/** Admin: respond to a feedback entry. The reply shows on the user's feedback page. */
router.patch("/api/admin/feedback/:id/reply", async (req, res, next) => {
  try {
    const { reply } = replySchema.parse(req.body);

    const { data, error } = await supabaseAdmin
      .from("feedback")
      .update({ admin_reply: reply, admin_replied_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Feedback not found" });

    res.json({ feedback: data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid reply" });
    }
    next(err);
  }
});

const BRANDING_EXTENSIONS = {
  ico: "image/x-icon",
  png: "image/png",
  svg: "image/svg+xml",
};

const brandingUploadSchema = z.object({
  filename: z.string().trim().regex(/^[a-zA-Z0-9._-]+$/).max(120),
  data_base64: z.string().min(1).max(2_000_000), // ~1.4 MB decoded cap
});

/**
 * Admin: upload a custom logo/favicon (.ico, .png or .svg). Written to the
 * public assets bucket under branding/ and recorded in app_branding so the
 * web app picks it up on every page (nav logo + favicon).
 */
router.post("/api/admin/branding", brandingParser, async (req, res, next) => {
  try {
    const { filename, data_base64 } = brandingUploadSchema.parse(req.body);

    const ext = filename.split(".").pop()?.toLowerCase();
    const contentType = BRANDING_EXTENSIONS[ext];
    if (!contentType) {
      return res.status(400).json({ error: "File must be .ico, .png or .svg" });
    }

    const buffer = Buffer.from(data_base64, "base64");
    if (buffer.length === 0 || buffer.length > 1_000_000) {
      return res.status(400).json({ error: "File must be between 1 byte and 1 MB" });
    }

    const path = `branding/logo.${ext}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("assets")
      .upload(path, buffer, { contentType, upsert: true });
    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabaseAdmin.storage.from("assets").getPublicUrl(path);
    const url = `${publicUrl.publicUrl}?v=${Date.now()}`; // cache-bust favicon

    // Keep only the current file around.
    await supabaseAdmin.storage
      .from("assets")
      .remove(
        Object.keys(BRANDING_EXTENSIONS)
          .filter((e) => e !== ext)
          .map((e) => `branding/logo.${e}`)
      )
      .catch(() => {});

    const now = new Date().toISOString();
    const { error: upsertError } = await supabaseAdmin
      .from("app_branding")
      .upsert([
        { key: "logo_url", value: url, updated_at: now },
        { key: "favicon_url", value: url, updated_at: now },
      ]);
    if (upsertError) throw upsertError;

    res.json({ logoUrl: url, faviconUrl: url });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid upload" });
    }
    next(err);
  }
});

/** Admin: revert to the default ClipForge logo/favicon. */
router.delete("/api/admin/branding", async (req, res, next) => {
  try {
    await supabaseAdmin.from("app_branding").delete().in("key", ["logo_url", "favicon_url"]);
    await supabaseAdmin.storage
      .from("assets")
      .remove(Object.keys(BRANDING_EXTENSIONS).map((e) => `branding/logo.${e}`))
      .catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function countBy(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
  return map;
}

export default router;
