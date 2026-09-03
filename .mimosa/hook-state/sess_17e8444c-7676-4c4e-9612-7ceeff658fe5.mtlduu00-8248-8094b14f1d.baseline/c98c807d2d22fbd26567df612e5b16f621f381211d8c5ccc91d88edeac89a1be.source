import { Router } from "express";

const router = Router();

router.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "clipforge-api", time: new Date().toISOString() });
});

export default router;
