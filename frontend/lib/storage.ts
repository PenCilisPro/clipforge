import { apiFetch } from "./api";

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

/** Public URL for files in the R2 `assets` prefix (thumbnails, screenshots). */
export function publicAssetUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}/assets/${path}`;
}
