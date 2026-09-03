import fs from "node:fs/promises";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, reconcileProjectDone } from "../lib/jobs.js";
import { ensureTmpDir, tmpPath, cleanup } from "../lib/ffmpeg.js";

/**
 * Idempotent finalization: download the finished render from Shotstack's CDN
 * and re-upload it to the Supabase `clips` bucket for permanent ownership.
 * Safe to run twice (webhook race with inline polling).
 */
export async function finalizeClip({ projectId, clipId, renderUrl, jobRowId = null }) {
  if (!clipId) throw new Error("finalizeClip requires clipId");

  const { data: clip } = await supabaseAdmin
    .from("clips")
    .select("id, user_id, storage_path, status")
    .eq("id", clipId)
    .single();
  if (!clip) throw new Error(`Clip ${clipId} not found`);

  if (clip.storage_path) {
    // Already finalized — just make sure the dashboard is consistent.
    await reconcileProjectDone(projectId);
    if (jobRowId) await setJobStatus(jobRowId, "completed");
    return { clipId, alreadyFinalized: true };
  }

  await ensureTmpDir();
  const localFinal = tmpPath(`final-${clipId}.mp4`);

  const res = await fetch(renderUrl, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Failed to download rendered clip (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(localFinal, Buffer.from(arrayBuffer));

  const storagePath = `${clip.user_id}/${clipId}.mp4`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from("clips")
    .upload(storagePath, await fs.readFile(localFinal), {
      contentType: "video/mp4",
      upsert: true,
    });
  if (uploadError) throw uploadError;
  await cleanup(localFinal);

  const { error: updateError } = await supabaseAdmin
    .from("clips")
    .update({ storage_path: storagePath, status: "ready", error_message: null })
    .eq("id", clipId);
  if (updateError) throw updateError;

  await reconcileProjectDone(projectId);
  if (jobRowId) await setJobStatus(jobRowId, "completed");
  return { clipId, storagePath };
}

/**
 * BullMQ stage handler for the webhook-driven path.
 * If no jobRowId is provided, completes the clip's active render job row.
 */
export async function processFinalize(job) {
  const { projectId, clipId, renderUrl, jobRowId } = job.data;

  try {
    let rowId = jobRowId;
    if (!rowId) {
      const { data: activeRender } = await supabaseAdmin
        .from("jobs")
        .select("id")
        .eq("clip_id", clipId)
        .eq("job_type", "render")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      rowId = activeRender?.id ?? null;
    }

    return await finalizeClip({ projectId, clipId, renderUrl, jobRowId: rowId });
  } catch (error) {
    if (clipId) {
      await supabaseAdmin
        .from("clips")
        .update({ status: "failed", error_message: error.message })
        .eq("id", clipId);
    }
    if (jobRowId) await setJobStatus(jobRowId, "failed", error.message);
    await reconcileProjectDone(projectId);
    throw error;
  }
}
