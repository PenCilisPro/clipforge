import { env } from "../config/env.js";

/**
 * Admin gate — must run after requireAuth. Only allowlisted emails pass;
 * everyone else gets a 403 that doesn't reveal whether the route exists.
 */
export function requireAdmin(req, res, next) {
  const email = (req.user?.email ?? "").toLowerCase();
  if (!email || !env.adminEmails.includes(email)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}
