import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { download, downloadBuffer, listByPrefix } from "./r2.js";

/**
 * Source-video retrieval. Large uploads are stored as multiple parts
 * (each under the browser's per-request upload cap) plus a manifest.json —
 * reassemble them locally into a single file. No merged file is ever
 * re-uploaded.
 */

const MANIFEST_SUFFIX = "/manifest.json";
const BUCKET = "source-videos";

export function isSplitSource(path) {
  return String(path ?? "").endsWith(MANIFEST_SUFFIX);
}

/**
 * Stream one object straight to a file. Never buffer a video in the Node
 * heap — a multi-hundred-MB source OOM-kills the whole container (this
 * shipped once: the worker crash-looped and every clip sat in "rendering").
 */
async function downloadToFile(key, filePath, { append = false } = {}) {
  const body = await download(key);
  if (append) {
    await pipeline(body, fs.createWriteStream(filePath, { flags: "a" }));
  } else {
    await pipeline(body, fs.createWriteStream(filePath));
  }
}

/**
 * Pull the project's source video to a local file, transparently
 * reassembling split uploads. `localPath` is written incrementally.
 */
export async function fetchSourceVideo(project, localPath) {
  const path = project.original_video_path;
  // The stored path must live under the project owner's folder — the
  // service credentials bypass any access control, so this is the only
  // guard against a tampered row pulling another user's video.
  if (!String(path ?? "").startsWith(`${project.user_id}/`)) {
    throw new Error("Source video path does not belong to the project owner");
  }
  if (!isSplitSource(path)) {
    await downloadToFile(`${BUCKET}/${path}`, localPath);
    return localPath;
  }

  const manifest = JSON.parse(
    (await downloadBuffer(`${BUCKET}/${path}`)).toString("utf8")
  );
  const parts = Array.isArray(manifest.parts) ? manifest.parts : [];
  if (parts.length === 0) throw new Error("Split upload manifest has no parts");

  let first = true;
  for (const part of parts) {
    if (!String(part ?? "").startsWith(`${project.user_id}/`)) {
      throw new Error(`Upload part ${part} does not belong to the project owner`);
    }
    await downloadToFile(`${BUCKET}/${part}`, localPath, { append: !first });
    first = false;
  }
  return localPath;
}

/** All storage objects belonging to a project's source video (parts included). */
export async function sourceStoragePaths(originalVideoPath) {
  if (!isSplitSource(originalVideoPath)) return [originalVideoPath];
  const folder = String(originalVideoPath).split("/").slice(0, -1).join("/");
  try {
    const keys = await listByPrefix(`${BUCKET}/${folder}/`);
    return keys.map((k) => k.replace(`${BUCKET}/`, ""));
  } catch {
    return [originalVideoPath];
  }
}
