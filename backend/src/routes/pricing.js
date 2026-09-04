import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";

const router = Router();

/**
 * Public pricing content — powers the landing pricing section and /pricing.
 * No auth: it's marketing data, and the landing page renders signed-out.
 */
router.get("/api/pricing", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("pricing_plans")
      .select("*")
      .order("sort_order");
    if (error) throw error;
    res.json({ plans: data ?? [] });
  } catch (err) {
    next(err);
  }
});

const planUpdateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  tagline: z.string().trim().max(160).default(""),
  monthly_price: z.coerce.number().finite().min(0).max(1_000_000),
  annual_price: z.coerce.number().finite().min(0).max(1_000_000),
  credits_label: z.string().trim().max(160).default(""),
  features: z.array(z.string().trim().min(1).max(240)).max(24).default([]),
  cta_label: z.string().trim().min(1).max(60).default("Get started"),
  highlighted: z.coerce.boolean().default(false),
});

/** Admin: update a plan's display name, price, tagline, CTA and privileges. */
router.patch(
  "/api/admin/pricing/:planKey",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const body = planUpdateSchema.parse(req.body);

      const { data, error } = await supabaseAdmin
        .from("pricing_plans")
        .update(body)
        .eq("plan_key", req.params.planKey)
        .select("*")
        .single();
      if (error || !data) {
        return res.status(404).json({ error: "Unknown plan" });
      }

      res.json({ plan: data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid plan data" });
      }
      next(err);
    }
  }
);

export default router;
