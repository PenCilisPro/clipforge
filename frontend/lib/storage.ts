import { apiFetch } from "./api";
import { safeUploadName } from "./utils";

/**
 * Direct browser → R2 uploads via backend presigned PUTs (replaces direct
 * Supabase Storage uploads). The path must be inside the signed-in user's
 * own folder — the backend enforces that before signing.
 */
export async function uploadToR2(
  bucket: "source-videos" | "user-uploads" | "assets",
  path: string,
  body: Blob | File,
  contentType: string
): Promise<void> {
  const { url } = await apiFetch<{ url: string }>("/api/uploads/presign", {
    method: "POST",
    body: { bucket, path, contentType },
  });
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

// Must match the backend's cap in backend/src/routes/projects.js.
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

// S3 multipart part size. R2's minimum is 5 MB (except the last part); 64 MB
// keeps a 1 GB file at ~16 parts so retries stay cheap.
const PART_BYTES = 64 * 1024 * 1024;

type Progress = (uploadedBytes: number, totalBytes: number) => void;

/** PUT one part to its presigned URL, retrying transient failures. Returns the ETag. */
async function putPart(url: string, chunk: Blob, attempts = 3): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: chunk });
      if (!res.ok) throw new Error(`Part upload failed (${res.status})`);
      // R2 bucket CORS must expose the ETag header (ExposeHeaders: ["ETag"]);
      // without it the browser cannot see the value CompleteMultipartUpload needs.
      const etag = res.headers.get("etag");
      if (!etag) throw new Error("Part upload returned no ETag");
      return etag.replace(/"/g, "");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
      }
    }
  }
  throw lastError ?? new Error("Part upload failed");
}

/**
 * S3 multipart upload: the backend creates the upload and presigns every
 * part, the browser PUTs each part straight to R2, and the joined object
 * exists natively in R2 — nothing source-sized ever passes through the
 * API/worker service.
 */
async function uploadMultipart(
  bucket: "source-videos",
  path: string,
  file: File,
  onProgress: Progress
): Promise<string> {
  const partCount = Math.ceil(file.size / PART_BYTES);
  const { key, uploadId, urls } = await apiFetch<{
    key: string;
    uploadId: string;
    urls: string[];
  }>("/api/uploads/multipart", {
    method: "POST",
    body: { bucket, path, contentType: "video/mp4", partCount },
  });

  try {
    let uploaded = 0;
    const etags: { partNumber: number; etag: string }[] = [];
    for (let i = 0; i < partCount; i++) {
      // Blob without a type → fetch sends no Content-Type header, which the
      // part signature doesn't cover.
      const chunk = new Blob([file.slice(i * PART_BYTES, Math.min((i + 1) * PART_BYTES, file.size))]);
      const etag = await putPart(urls[i], chunk);
      etags.push({ partNumber: i + 1, etag });
      uploaded += chunk.size;
      onProgress(Math.min(uploaded, file.size), file.size);
    }
    await apiFetch("/api/uploads/multipart/complete", {
      method: "POST",
      body: { key, uploadId, parts: etags },
    });
  } catch (err) {
    // Never leave orphaned parts behind — aborting is a no-op once completed.
    await apiFetch("/api/uploads/multipart/abort", {
      method: "POST",
      body: { key, uploadId },
    }).catch(() => {});
    throw err;
  }

  // Callers store the bare path; the bucket prefix is added server-side.
  return path;
}

/**
 * Legacy fallback for older backends (or R2 buckets whose CORS doesn't expose
 * ETags): ~40 MB parts uploaded as plain objects plus a manifest.json the
 * worker stitches back together locally.
 */
async function uploadSplitParts(
  userId: string,
  fileName: string,
  file: File,
  onProgress: Progress
): Promise<string> {
  const LEGACY_PART_BYTES = 40 * 1024 * 1024;
  const uploadId = `${Date.now()}-${safeUploadName(fileName).replace(/\.[^.]+$/, "")}`;
  const folder = `${userId}/parts/${uploadId}`;
  const parts: string[] = [];
  for (let offset = 0, i = 0; offset < file.size; offset += LEGACY_PART_BYTES, i++) {
    const partPath = `${folder}/part-${String(i).padStart(5, "0")}`;
    await uploadToR2("source-videos", partPath, file.slice(offset, offset + LEGACY_PART_BYTES), "application/octet-stream");
    parts.push(partPath);
    onProgress(Math.min(offset + LEGACY_PART_BYTES, file.size), file.size);
  }
  // Manifest is the project's storage_path — its presence means every part
  // made it, and the worker keys off the .json suffix.
  const manifestPath = `${folder}/manifest.json`;
  await uploadToR2(
    "source-videos",
    manifestPath,
    new Blob([JSON.stringify({ parts, size: file.size })], { type: "application/json" }),
    "application/json"
  );
  return manifestPath;
}

/**
 * Upload a source video, choosing the cheapest path the backend supports.
 * Returns the storage path to pass as the project's `storage_path`.
 */
export async function uploadVideoToR2(
  userId: string,
  path: string,
  file: File,
  onProgress: Progress
): Promise<string> {
  if (file.size <= PART_BYTES) {
    await uploadToR2("source-videos", path, file, "video/mp4");
    onProgress(file.size, file.size);
    return path;
  }
  try {
    return await uploadMultipart("source-videos", path, file, onProgress);
  } catch (err) {
    // The multipart endpoints need the backend (and bucket CORS) to support
    // them; anything else still works through the legacy split-part flow.
    console.warn("[storage] multipart upload unavailable, falling back to split parts:", err);
    return uploadSplitParts(userId, file.name, file, onProgress);
  }
}

/** Public URL for files in the R2 `assets` prefix (thumbnails, screenshots). */
export function publicAssetUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}/assets/${path}`;
}
