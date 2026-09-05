import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { isProOrAdmin } from "../lib/tiers.js";

const router = Router();

const PHONE_COUNTRIES = [
  "+1", "+7", "+20", "+27", "+31", "+33", "+34", "+39", "+41", "+43", "+44",
  "+45", "+46", "+47", "+48", "+49", "+51", "+52", "+55", "+58", "+61", "+62",
  "+63", "+64", "+65", "+66", "+81", "+82", "+84", "+86", "+90", "+91", "+92",
  "+94", "+95", "+98", "+211", "+213", "+216", "+218", "+220", "+221", "+233",
  "+234", "+237", "+254", "+256", "+507", "+593", "+595", "+598", "+852",
  "+853", "+855", "+856", "+880", "+886", "+960", "+961", "+962", "+963",
  "+964", "+966", "+968", "+971", "+973", "+974",
];

const requestSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required").max(100),
  last_name: z.string().trim().min(1, "Last name is required").max(100),
  email: z.string().trim().email("A valid email is required").max(200),
  phone_country: z
    .string()
    .trim()
    .refine((v) => PHONE_COUNTRIES.includes(v), "Pick a valid country calling code"),
  phone_number: z
    .string()
    .trim()
    .regex(/^[0-9 ()-]{4,20}$/, "Enter a valid phone number"),
  header: z
    .string()
    .trim()
    .min(1, "Header is required")
    .max(200, "Header must be under 200 characters"),
  plan_use: z
    .string()
    .trim()
    .min(1, "Tell us what you're planning to do")
    .max(4000),
  other_info: z.string().trim().max(4000).nullish().transform((v) => v || null),
  // Uploaded by the browser into the user's own folder in the assets bucket.
  attachment_path: z.string().trim().max(500).nullish().transform((v) => v || null),
});

router.get("/api/upgrade-requests", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("upgrade_requests")
      .select("id, status, admin_note, reviewed_at, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ requests: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/** Submit a free-upgrade request (any signed-in user, one pending at a time). */
router.post("/api/upgrade-requests", requireAuth, async (req, res, next) => {
  try {
    const body = requestSchema.parse(req.body);

    if (body.attachment_path && !body.attachment_path.startsWith(`${req.user.id}/`)) {
      return res.status(400).json({ error: "Invalid attachment path" });
    }

    const { count } = await supabaseAdmin
      .from("upgrade_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .eq("status", "pending");
    if ((count ?? 0) > 0) {
      return res.status(409).json({
        error: "You already have a request being reviewed — hang tight.",
      });
    }

    if (await isProOrAdmin(req.user.id, req.user.email)) {
      return res
        .status(409)
        .json({ error: "Your account already has a paid plan or admin access." });
    }

    const { data, error } = await supabaseAdmin
      .from("upgrade_requests")
      .insert({
        user_id: req.user.id,
        first_name: body.first_name,
        last_name: body.last_name,
        email: body.email,
        phone_country: body.phone_country,
        phone_number: body.phone_number,
        header: body.header,
        plan_use: body.plan_use,
        other_info: body.other_info,
        attachment_path: body.attachment_path,
      })
      .select("id, status, created_at")
      .single();
    if (error) throw error;

    res.status(201).json({ request: data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request" });
    }
    next(err);
  }
});

export default router;
