import { supabaseAdmin } from "../lib/supabase.js";

/**
 * Verifies the Supabase JWT from the Authorization header and attaches
 * `req.user` (id, email) on success.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Missing access token" });
  }

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = { id: user.id, email: user.email };
  next();
}
