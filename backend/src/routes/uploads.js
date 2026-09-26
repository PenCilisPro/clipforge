import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  presignPut,
  createMultipartUpload,
  presignUploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
} from "../lib/r2.js";

const router = Router();

// Buckets the browser may write to directly, and what it may put there.
const ALLOWED_PREFIXES = [
  { prefix: "source-videos", contentTypes: ["video/mp4", "application/octet-stream", "application/json"] },
  { prefix: "user-uploads", contentTypes: ["video/mp4", "audio/mpeg"] },
  {
    prefix: "assets",
    contentTypes: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "application/octet-stream",
    ],
  },
];

const presignSchema = z.object({
  bucket: z.enum(["source-videos", "user-uploads", "assets"]),
  path: z.string().min(1).max(600),
  contentType: z.string().min(3).max(100),
});

/**
 * Presigned PUT for direct browser → R2 uploads (replaces direct Supabase
 * Storage uploads). The path must live in the caller's own folder and the
 * content type must match the bucket's purpose. The browser PUTs the file
 * to the returned URL; the key is then passed to the normal project/clip
 * endpoints, which verify existence server-side.
 */
router.post("/api/uploads/presign", requireAuth, async (req, res, next) => {
  try {
    const { bucket, path, contentType } = presignSchema.parse(req.body);
    if (!path.startsWith(`${req.user.id}/`)) {
      return res.status(403).json({ error: "Upload path must be in your own folder" });
    }
    const allowed = ALLOWED_PREFIXES.find((b) => b.prefix === bucket);
    if (!allowed?.contentTypes.includes(contentType)) {
      return res.status(400).json({ error: `Content type ${contentType} not allowed in ${bucket}` });
    }
    const url = await presignPut(`${bucket}/${path}`, contentType, 60 * 60);
    res.json({ url, key: `${bucket}/${path}` });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid upload request" });
    }
    next(err);
  }
});

// ── Multipart uploads ────────────────────────────────────────────────────────
// Large videos are assembled inside R2 by the browser (one PUT per part), so
// the constrained API/worker service never moves source-sized bytes. Only
// metadata calls hit this service: create, complete, abort.

const multipartCreateSchema = presignSchema.extend({
  partCount: z.coerce.number().int().min(2).max(10000),
});

router.post("/api/uploads/multipart", requireAuth, async (req, res, next) => {
  try {
    const { bucket, path, contentType, partCount } = multipartCreateSchema.parse(req.body);
    if (!path.startsWith(`${req.user.id}/`)) {
      return res.status(403).json({ error: "Upload path must be in your own folder" });
    }
    const allowed = ALLOWED_PREFIXES.find((b) => b.prefix === bucket);
    if (!allowed?.contentTypes.includes(contentType)) {
      return res.status(400).json({ error: `Content type ${contentType} not allowed in ${bucket}` });
    }
    const key = `${bucket}/${path}`;
    const uploadId = await createMultipartUpload(key, contentType);
    // Presign every part up front with 24 h validity — a slow uplink can take
    // hours to push 1 GB, and per-part presign round trips are pointless.
    const urls = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      urls.push(await presignUploadPart(key, uploadId, partNumber));
    }
    res.json({ key, uploadId, urls });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid upload request" });
    }
    next(err);
  }
});

const multipartCompleteSchema = z.object({
  key: z.string().min(3).max(700),
  uploadId: z.string().min(10).max(200),
  parts: z
    .array(
      z.object({
        partNumber: z.coerce.number().int().min(1).max(10000),
        etag: z.string().min(4).max(100),
      })
    )
    .min(1),
});

router.post("/api/uploads/multipart/complete", requireAuth, async (req, res, next) => {
  try {
    const { key, uploadId, parts } = multipartCompleteSchema.parse(req.body);
    // Same folder rule as presigning: the key must be <bucket>/<uid>/… and the
    // bucket must be one the browser is allowed to write to at all.
    const bucket = key.split("/")[0];
    const allowed = ALLOWED_PREFIXES.find((b) => b.prefix === bucket);
    if (!allowed || !key.startsWith(`${bucket}/${req.user.id}/`)) {
      return res.status(403).json({ error: "Upload path must be in your own folder" });
    }
    await completeMultipartUpload(key, uploadId, parts);
    res.json({ key });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid upload request" });
    }
    next(err);
  }
});

router.post("/api/uploads/multipart/abort", requireAuth, async (req, res, next) => {
  try {
    const { key, uploadId } = multipartCompleteSchema.pick({ key: true, uploadId: true }).parse(req.body);
    const bucket = key.split("/")[0];
    const allowed = ALLOWED_PREFIXES.find((b) => b.prefix === bucket);
    if (!allowed || !key.startsWith(`${bucket}/${req.user.id}/`)) {
      return res.status(403).json({ error: "Upload path must be in your own folder" });
    }
    // Best effort — orphaned parts are worse than a failed cleanup response.
    await abortMultipartUpload(key, uploadId).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid upload request" });
    }
    next(err);
  }
});

export default router;
