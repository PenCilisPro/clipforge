import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const CATEGORIES = ["general", "bug_report", "feature_request", "billing"];

const feedbackSchema = z.object({
  message: z.string().trim().min(1, "Feedback cannot be empty").max(4000),
  category: z.enum(CATEGORIES).default("general"),
  rating: z.coerce.number().int().min(1).max(5).nullable().optional(),
  contact_email: z
    .union([z.literal(""), z.string().trim().email().max(200)])
    .optional()
    .transform((v) => (v ? v : null)),
  // Screenshot uploaded by the browser straight to the user's own folder in
  // the public assets bucket — enforce ownership so paths can't be forged.
  screenshot_path: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
});

/** Submit feedback (any signed-in user). Surfaced on the admin page. */
router.post("/api/feedback", requireAuth, async (req, res, next) => {
  try {
    const { message, category, rating, contact_email, screenshot_path } =
      feedbackSchema.parse(req.body);

    if (screenshot_path && !screenshot_path.startsWith(`${req.user.id}/`)) {
      return res.status(400).json({ error: "Invalid screenshot path" });
    }

    const { error } = await supabaseAdmin.from("feedback").insert({
      user_id: req.user.id,
      message,
      category,
      rating: rating ?? null,
      contact_email,
      screenshot_path,
    });
    if (error) throw error;

    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid feedback" });
    }
    next(err);
  }
});

export default router;
