import { getAuth } from "firebase-admin/auth";
import { db } from "../lib/firebase.js";
import { env } from "../config/env.js";

/**
 * Verifies the Firebase ID token from the Authorization header, ensures a
 * matching profile document exists (replacing the old Supabase
 * handle_new_user trigger), stamps admin custom claims for the allowlist,
 * and attaches `req.user` (id, email) on success.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Missing access token" });
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token, true);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const uid = decoded.uid;
  const email = (decoded.email ?? "").toLowerCase();

  try {
    const ref = db().collection("profiles").doc(uid);
    const snap = await ref.get();

    if (!snap.exists) {
      await ref.set({
        id: uid,
        email: email || null,
        display_name:
          decoded.name ?? decoded.full_name ?? (email ? email.split("@")[0] : "Creator"),
        avatar_url: decoded.picture ?? null,
        plan: "free",
        credits_remaining: 60,
        theme_preference: "system",
        created_at: new Date().toISOString(),
      });
    }

    // Keep admin custom claims in sync with the allowlist.
    const isAdmin = env.adminEmails.includes(email);
    if (isAdmin && decoded.admin !== true) {
      await getAuth().setCustomUserClaims(uid, { admin: true });
    } else if (!isAdmin && decoded.admin === true) {
      await getAuth().setCustomUserClaims(uid, { admin: false });
    }
  } catch (e) {
    console.error("[auth] profile sync failed:", e.message);
  }

  req.user = { id: uid, email };
  next();
}
