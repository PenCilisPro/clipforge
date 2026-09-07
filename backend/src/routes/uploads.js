import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { presignPut } from "../lib/r2.js";

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

export default router;
