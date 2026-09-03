import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * Service-role client. Bypasses RLS — backend + worker only.
 */
export const supabaseAdmin = createClient(
  env.supabaseUrl ?? "http://localhost",
  env.supabaseServiceKey ?? "missing",
  { auth: { persistSession: false } }
);
