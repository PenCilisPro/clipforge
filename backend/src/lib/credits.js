import { supabaseAdmin } from "./supabase.js";

const REFILL_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Top a user's credits back up to their plan's monthly allotment when the
 * 30-day window since their last refresh has elapsed. No-op otherwise.
 * Called before credits are displayed or spent.
 */
export async function ensureMonthlyCredits(userId) {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("plan, credits_remaining, credits_refreshed_at")
    .eq("id", userId)
    .single();
  if (!profile) return null;

  const refreshedAt = profile.credits_refreshed_at
    ? new Date(profile.credits_refreshed_at).getTime()
    : 0;
  if (refreshedAt && Date.now() - refreshedAt < REFILL_INTERVAL_MS) {
    return Number(profile.credits_remaining);
  }

  const { data: plan } = await supabaseAdmin
    .from("pricing_plans")
    .select("credits_per_month")
    .eq("plan_key", profile.plan ?? "free")
    .single();

  const credits = plan?.credits_per_month ?? 0;
  await supabaseAdmin
    .from("profiles")
    .update({ credits_remaining: credits, credits_refreshed_at: new Date().toISOString() })
    .eq("id", userId);
  return credits;
}

/** The monthly allotment of a plan (fallback 0 for unknown plans). */
export async function planCreditsPerMonth(planKey) {
  const { data } = await supabaseAdmin
    .from("pricing_plans")
    .select("credits_per_month")
    .eq("plan_key", planKey)
    .single();
  return data?.credits_per_month ?? 0;
}
