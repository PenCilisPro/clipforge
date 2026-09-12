import { createClient } from "./firestore.js";

/**
 * Supabase-compatible data client, now backed by Cloud Firestore.
 * Same builder API (from/select/eq/insert/update/upsert/delete/rpc) so the
 * rest of the codebase is unchanged. Runs with admin privileges — call
 * sites are trusted (backend + worker only).
 */
export const supabaseAdmin = createClient();
