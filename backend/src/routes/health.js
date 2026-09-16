import { Router } from "express";
import { getAuth } from "firebase-admin/auth";

const router = Router();

router.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "clipforge-api", time: new Date().toISOString() });
});

// TEMPORARY DIAGNOSTIC — remove after the token-verification regression is
// diagnosed. Surfaces the exact Admin SDK error plus outbound reachability
// of the Google endpoints verifyIdToken depends on.
router.get("/api/health/auth-diag", async (req, res) => {
  const out = { time: new Date().toISOString() };
  for (const [name, url] of [
    ["securetoken_jwks", "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com"],
    ["oauth_tokeninfo", "https://oauth2.googleapis.com/tokeninfo"],
  ]) {
    try {
      const t0 = Date.now();
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      out[name] = { status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      out[name] = { error: e.message };
    }
  }
  const token = String(req.query.token ?? "");
  if (token) {
    try {
      const decoded = await getAuth().verifyIdToken(token, true);
      out.verify = { ok: true, uid: decoded.uid };
    } catch (e) {
      out.verify = { ok: false, code: e.code, message: e.message };
    }
    try {
      const decoded = await getAuth().verifyIdToken(token, false);
      out.verifyNoRevoke = { ok: true, uid: decoded.uid };
    } catch (e) {
      out.verifyNoRevoke = { ok: false, code: e.code, message: e.message };
    }
  }
  res.json(out);
});

export default router;
