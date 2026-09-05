import fs from "node:fs/promises";
import { supabaseAdmin } from "./supabase.js";

/**
 * Source-video retrieval. Large uploads are stored as multiple parts
 * (each under Supabase's per-file upload cap) plus a manifest.json —
 * reassemble them locally into a single file. No merged file is ever
 * re-uploaded, since that would hit the same cap.
 */

const MANIFEST_SUFFIX = "/manifest.json";

export function isSplitSource(path) {
  return String(path ?? "").endsWith(MANIFEST_SUFFIX);
}

/**
 * Pull the project's source video to a local file, transparently
 * reassembling split uploads. `localPath` is written incrementally.
 */
export async function fetchSourceVideo(project, localPath) {
  const path = project.original_video_path;
  if (!isSplitSource(path)) {
    const { data: blob, error } = await supabaseAdmin.storage
      .from("source-videos")
      .download(path);
    if (error) throw error;
    await fs.writeFile(localPath, Buffer.from(await blob.arrayBuffer()));
    return localPath;
  }

  const { data: manifestBlob, error: manifestError } = await supabaseAdmin.storage
    .from("source-videos")
    .download(path);
  if (manifestError) throw manifestError;
  const manifest = JSON.parse(await manifestBlob.text());
  const parts = Array.isArray(manifest.parts) ? manifest.parts : [];
  if (parts.length === 0) throw new Error("Split upload manifest has no parts");

  await fs.writeFile(localPath, Buffer.alloc(0));
  for (const part of parts) {
    const { data: blob, error } = await supabaseAdmin.storage
      .from("source-videos")
      .download(part);
    if (error) throw new Error(`Missing upload part ${part}: ${error.message}`);
    await fs.appendFile(localPath, Buffer.from(await blob.arrayBuffer()));
  }
  return localPath;
}

/** All storage objects belonging to a project's source video (parts included). */
export async function sourceStoragePaths(originalVideoPath) {
  if (!isSplitSource(originalVideoPath)) return [originalVideoPath];
  const folder = String(originalVideoPath).split("/").slice(0, -1).join("/");
  const { data: objects, error } = await supabaseAdmin.storage
    .from("source-videos")
    .list(folder, { limit: 1000 });
  if (error || !objects) return [originalVideoPath];
  return objects.map((o) => `${folder}/${o.name}`);
}
