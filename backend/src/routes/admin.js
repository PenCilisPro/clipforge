import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";

const router = Router();

router.use("/api/admin", requireAuth, requireAdmin);

/**
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
      .select("id, user_id, message, category, rating, created_at")
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

function countBy(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
  return map;
}

export default router;
