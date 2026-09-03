import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/api/me", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, email, display_name, avatar_url, plan, credits_remaining, created_at")
      .eq("id", req.user.id)
      .single();
    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

export default router;
