import { getAuth } from "firebase-admin/auth";
import { db } from "../lib/firebase.js";
import { env } from "../config/env.js";
import { PAID_PLANS } from "../lib/tiers.js";

/**
 * Verifies the Firebase ID token from the Authorization header, ensures a
 * matching profile document exists (replacing the old Supabase
 * handle_new_user trigger), stamps admin custom claims for the allowlist,
 * and attaches `req.user` (id, email) on success.
 */

// verifyIdToken(token, true) makes a live round trip to Google's
// identitytoolkit on EVERY request (revocation check), and a fresh
// container additionally needs to fetch Google's public signing keys. This
// deployment has a history of container-side DNS/resolver outages — when
// Google is unreachable those calls fail and every authenticated request
// would 401 even though the token itself is perfectly valid. Distinguish
// real token problems (expired / revoked / bad signature) from
// infrastructure failures so auth degrades instead of dying with them.
const NETWORK_ERROR_RE =
  /getaddrinfo|eai_again|enotfound|etimedout|econnreset|econnrefused|socket hang up|fetch failed|network/i;

function isNetworkError(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  if (code === "auth/network-request-failed") return true;
  // firebase-admin reports genuine token problems with an auth/* code —
  // never bypass the check for those.
  if (code.startsWith("auth/")) return false;
  return NETWORK_ERROR_RE.test(err?.message ?? String(err ?? ""));
}

// A live Google round trip can do worse than fail — during a local render the
// observed worst case was a revocation check hanging ~8.5 MINUTES before the
// socket finally reset (ECONNRESET at 07:58:50 for a request that entered at
// 07:50:35). The browser had long given up, the token expired mid-hang, and
// the user saw a 401 storm plus gateway-timeout pages the browser phrases as
// CORS errors. Every network dependency in this middleware therefore runs
// under a deadline: fail fast, degrade to the local-only verification path,
// and never let a request sit in auth for more than a few seconds.
const AUTH_DEADLINE_MS = Number(process.env.AUTH_DEADLINE_MS) || 12000;
const PROFILE_SYNC_DEADLINE_MS = Number(process.env.PROFILE_SYNC_DEADLINE_MS) || 8000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms (socket hang up)`);
      err.code = "ETIMEDOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Missing access token" });
  }

  let decoded;
  try {
    decoded = await withTimeout(
      getAuth().verifyIdToken(token, true),
      AUTH_DEADLINE_MS,
      "revocation check"
    );
  } catch (err) {
    // Google unreachable (container resolver outage, cold-boot key fetch
    // failure, revocation lookup hanging, etc.): fall back to a local-only
    // verification — signature + expiry + audience are still enforced, only
    // the revocation lookup is skipped, loudly.
    if (isNetworkError(err)) {
      console.warn(
        `[auth] revocation check unreachable (${err?.message ?? err}) — verifying without it`
      );
      try {
        // The fallback also touches the network on a cold container (first
        // fetch of Google's public signing keys), so it gets the same cap.
        decoded = await withTimeout(
          getAuth().verifyIdToken(token, false),
          AUTH_DEADLINE_MS,
          "token verify"
        );
      } catch (err2) {
        console.error(
          "[auth] token verify failed:",
          err2?.code ?? "no-code",
          err2?.message ?? err2
        );
        return res
          .status(401)
          .json({ error: "Invalid or expired token", code: err2?.code ?? "auth/unknown" });
      }
    } else {
      // Log the REAL reason. The old bare catch() turned 401 storms into
      // ghosts: e.g. setCustomUserClaims (admin allowlist sync below)
      // invalidates every ID token issued before it — the client keeps
      // reusing its cached, not-yet-expired copy and gets auth/user-token-
      // expired on every call until it refreshes. That looked identical to
      // a revoked user from the logs: nothing.
      console.error(
        "[auth] token verify failed:",
        err?.code ?? "no-code",
        err?.message ?? err
      );
      return res
        .status(401)
        .json({ error: "Invalid or expired token", code: err?.code ?? "auth/unknown" });
    }
  }

  const uid = decoded.uid;
  const email = (decoded.email ?? "").toLowerCase();

  // Profile ensure + admin-claim sync are convenience work: a request must
  // never queue behind them. The whole block runs under one deadline — on
  // timeout the caller proceeds unauthenticated-synced (req.user is already
  // set below) and the next request re-runs the sync. Without this cap the
  // Firestore read here hung for whole minutes during renders — same failure
  // class as the revocation check above.
  try {
    await withTimeout(
      (async () => {
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

        // Keep admin custom claims in sync with the allowlist. NOTE: this
        // invalidates all previously issued ID tokens for the user; the next
        // request carries the old token and 401s with auth/user-token-expired —
        // the frontend api client detects any 401, force-refreshes the token
        // and retries once, so this costs a single extra round trip.
        const isAdmin = env.adminEmails.includes(email);
        if (isAdmin && decoded.admin !== true) {
          await getAuth().setCustomUserClaims(uid, { admin: true });
        } else if (!isAdmin && decoded.admin === true) {
          await getAuth().setCustomUserClaims(uid, { admin: false });
        }

        // Admins always carry a Pro subscription.
        if (isAdmin && !PAID_PLANS.includes(snap.data()?.plan ?? "free")) {
          await ref.set({ plan: "pro" }, { merge: true });
        }
      })(),
      PROFILE_SYNC_DEADLINE_MS,
      "profile sync"
    );
  } catch (e) {
    console.error("[auth] profile sync failed:", e.message);
  }

  req.user = { id: uid, email };
  next();
}
