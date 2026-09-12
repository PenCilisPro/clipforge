import { createClient } from "./firestore.js";

/**
 * Supabase-compatible data client, now backed by Cloud Firestore.
 * Same builder API (from/select/eq/insert/update/upsert/delete/rpc) so the
 * rest of the worker is unchanged. Runs with admin privileges.
 */
export const supabaseAdmin = createClient();
