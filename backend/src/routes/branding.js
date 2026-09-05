import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase.js";

const router = Router();

/**
 * Public branding — custom logo/favicon uploaded from the admin page.
 * Stored in the public `assets` bucket under branding/; only the service
 * role can write there (user RLS scopes inserts to their own folder).
 */
router.get("/api/branding", async (req, res) => {
  const { data } = await supabaseAdmin.from("app_branding").select("key, value");
  const map = new Map((data ?? []).map((row) => [row.key, row.value]));

  let faq = null;
  try {
    const parsed = JSON.parse(map.get("faq_items") ?? "null");
    if (Array.isArray(parsed)) faq = parsed;
  } catch {
    // Fall back to the built-in defaults on the landing page.
  }

  res.json({
    logoUrl: map.get("logo_url") ?? null,
    faviconUrl: map.get("favicon_url") ?? null,
    faq,
  });
});

export default router;
