import { supabaseAdmin } from "./supabase.js";
import { env } from "../config/env.js";

export const PAID_PLANS = ["pro", "business"];

/**
 * True when the caller is an admin (email allowlist) or on a paid plan.
 * Used to gate pro-only features (extra channels, scheduled uploads, tiers).
 */
export async function isProOrAdmin(userId, email) {
  if (env.adminEmails.includes((email ?? "").toLowerCase())) return true;
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .single();
  return PAID_PLANS.includes(data?.plan ?? "free");
}
