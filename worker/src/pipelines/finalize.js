import { supabaseAdmin } from "../lib/supabase.js";
import { uploadFile as r2UploadFile, remove as r2Remove } from "../lib/r2.js";
import { setJobStatus, reconcileProjectDone } from "../lib/jobs.js";
import { ensureTmpDir, tmpPath, cleanup } from "../lib/ffmpeg.js";
import { downloadRenderedClip } from "../lib/shotstack.js";
import { streamConfigured, uploadToStream, deleteStreamVideo } from "../lib/stream.js";

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

  // downloadRenderedClip host-allowlists the URL (webhook-provided, never
  // trusted blindly) and streams the MP4 to disk.
  await downloadRenderedClip(renderUrl, localFinal);

  const storagePath = `${clip.user_id}/${clipId}.mp4`;
  await r2UploadFile(`clips/${storagePath}`, localFinal, "video/mp4");

  // Mirror the finished MP4 into Cloudflare Stream for playback delivery
  // (adaptive HLS + CDN MP4 in the clip editor). R2 stays the source of
  // truth — if Stream isn't configured or the upload fails, the editor
  // transparently falls back to R2 presigned playback. Stale mirrors from a
  // previous render of this clip are deleted before the new upload.
  let streamUid = null;
  if (streamConfigured()) {
    const { data: prev } = await supabaseAdmin
      .from("clips")
      .select("stream_uid")
      .eq("id", clipId)
      .single();
    if (prev?.stream_uid) {
      try {
        await deleteStreamVideo(prev.stream_uid);
      } catch {
        // Best-effort — the new mirror replaces it as playback source anyway.
      }
    }
    try {
      const { uid } = await uploadToStream(localFinal, { name: `clipforge-${clipId}` });
      streamUid = uid;
    } catch (err) {
      console.warn(`[finalize] Stream mirror failed for clip ${clipId}: ${err.message}`);
    }
  }

  await supabaseAdmin.from("clips").update({
    storage_path: storagePath,
    status: "ready",
    error_message: null,
    // stream_uid=null marks "no mirror yet"; the backend lazily flips
    // stream_ready once Stream finishes processing (or just plays from R2).
    stream_uid: streamUid,
    stream_ready: false,
  }).eq("id", clipId);
  await cleanup(localFinal);

  // The raw intermediate clip (`raw/<clipId>.mp4`) only exists so Shotstack
  // can fetch it during submission — the render is done now, and re-renders
  // re-trim from the source video, so the raw file is dead weight. Removing
  // it roughly halves per-clip storage. Best-effort.
  const { data: rawClip } = await supabaseAdmin
    .from("clips")
    .select("raw_clip_path")
    .eq("id", clipId)
    .single();
  if (rawClip?.raw_clip_path) {
    try {
      await r2Remove([`clips/${rawClip.raw_clip_path}`]);
    } catch {
      // Best-effort — never fail a finished clip over cleanup.
    }
  }

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
