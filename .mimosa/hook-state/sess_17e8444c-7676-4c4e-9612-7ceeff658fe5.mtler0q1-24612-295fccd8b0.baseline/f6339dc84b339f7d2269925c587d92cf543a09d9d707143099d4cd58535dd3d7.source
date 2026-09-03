import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const supabaseAdmin = createClient(
  env.supabaseUrl ?? "http://localhost",
  env.supabaseServiceKey ?? "missing",
  { auth: { persistSession: false } }
);
