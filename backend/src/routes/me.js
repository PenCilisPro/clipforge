import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";

const router = Router();

router.get("/api/me", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, email, display_name, avatar_url, plan, credits_remaining, created_at")
      .eq("id", req.user.id)
      .single();
    if (error) throw error;
    const isAdmin = env.adminEmails.includes((data.email ?? "").toLowerCase());
    res.json({ profile: { ...data, is_admin: isAdmin } });
  } catch (err) {
    next(err);
  }
});

export default router;
