import { supabaseAdmin } from "../lib/supabase.js";
import { uploadFile as r2UploadFile } from "../lib/r2.js";
import { setJobStatus, setProjectStatus, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import {
  ensureTmpDir,
  tmpPath,
  cleanup,
  probeDurationSeconds,
  sweepStaleTmpFiles,
  statDiskFree,
} from "../lib/ffmpeg.js";
import { downloadSourceVideo } from "../lib/rapidapi.js";
import { downloadSourceVideoViaModal } from "../lib/modaldl.js";
import { env } from "../lib/env.js";

/**
 * Stage 1 — download (URL projects).
 * Fetches the source video via RapidAPI and stores it in Supabase Storage
 * under `source-videos/{userId}/{projectId}.mp4`.
 */
export async function processDownload(job) {
  const { projectId, jobRowId } = job.data;
  // Hoisted so the catch path can free the disk: a stranded source-sized
  // download here was invisible to every later stage — each retry writes a
  // NEW UUID-prefixed file, so a handful of failed attempts silently ate
  // the whole ~1 GiB ephemeral disk and every job after them failed with
  // "No space left on device".
  let localFile = null;

  try {
    await setJobStatus(jobRowId, "active");
    await setProjectStatus(projectId, "processing");

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("id, user_id, source_url, source_type")
      .eq("id", projectId)
      .single();
    if (error || !project) throw new Error(`Project ${projectId} not found`);
    if (project.source_type !== "url" || !project.source_url) {
      throw new Error("Download stage reached for a non-URL project");
    }

    await ensureTmpDir();
    // Free stranded leftovers BEFORE pulling another source-sized file in —
    // this stage writes the biggest file on the worker's disk.
    await sweepStaleTmpFiles();
    const freeBefore = await statDiskFree();
    if (freeBefore != null) {
      console.log(`[download] tmp disk: ${Math.round(freeBefore / 1048576)} MB free before download`);
    }
    localFile = tmpPath(`source-${projectId}.mp4`);

    // Preferred: the free Modal yt-dlp downloader (MODAL_DOWNLOAD_URL).
    // RapidAPI (paid) stays as the fallback for when YouTube bot-checks
    // Modal's datacenter IPs or the endpoint is not configured yet.
    let downloadedVia = null;
    const downloadErrors = [];
    if (env.modalDownloadUrl) {
      try {
        const meta = await downloadSourceVideoViaModal(project.source_url, localFile);
        downloadedVia = "modal/yt-dlp";
        if (meta?.title) job.log(`Source: ${meta.title}`);
      } catch (err) {
        downloadErrors.push(`yt-dlp: ${err.message}`);
        console.warn(`[download] modal yt-dlp failed — ${err.message}`);
      }
    }
    if (!downloadedVia) {
      try {
        await downloadSourceVideo(project.source_url, localFile);
        downloadedVia = "rapidapi";
      } catch (err) {
        downloadErrors.push(`rapidapi: ${err.message}`);
      }
    }
    if (!downloadedVia) {
      throw new Error(`Could not download the source video — ${downloadErrors.join(" | ")}`);
    }
    console.log(`[download] fetched source via ${downloadedVia}`);

    const durationSeconds = await probeDurationSeconds(localFile).catch(() => null);

    const storagePath = `${project.user_id}/${projectId}.mp4`;
    // Stream from disk — buffering the whole video in the heap OOM-kills
    // small containers before the upload even starts.
    await r2UploadFile(`source-videos/${storagePath}`, localFile, "video/mp4");

    await supabaseAdmin
      .from("projects")
      .update({
        original_video_path: storagePath,
        duration_seconds: durationSeconds,
      })
      .eq("id", projectId);

    await cleanup(localFile);
    await setJobStatus(jobRowId, "completed");
    // Chain to the next stage — nothing else enqueues transcribe for URL projects.
    const transcribeJobRowId = await insertJobRow(projectId, "transcribe");
    await enqueuePipeline("transcribe", { projectId, jobRowId: transcribeJobRowId });
    job.log(`Downloaded ${durationSeconds?.toFixed(0) ?? "?"}s → ${storagePath}`);
    return { projectId, storagePath };
  } catch (error) {
    // The download/upload failed but the partially-written source file is
    // still on disk — remove it, or retries pile up source-sized files
    // until the ephemeral disk hits zero.
    await cleanup(localFile);
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}
