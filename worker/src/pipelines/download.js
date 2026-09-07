import { supabaseAdmin } from "../lib/supabase.js";
import { upload as r2Upload } from "../lib/r2.js";
import { setJobStatus, setProjectStatus, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import { ensureTmpDir, tmpPath, cleanup, probeDurationSeconds } from "../lib/ffmpeg.js";
import { downloadSourceVideo } from "../lib/rapidapi.js";

/**
 * Stage 1 — download (URL projects).
 * Fetches the source video via RapidAPI and stores it in Supabase Storage
 * under `source-videos/{userId}/{projectId}.mp4`.
 */
export async function processDownload(job) {
  const { projectId, jobRowId } = job.data;

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
    const localFile = tmpPath(`source-${projectId}.mp4`);
    await downloadSourceVideo(project.source_url, localFile);

    const durationSeconds = await probeDurationSeconds(localFile).catch(() => null);

    const storagePath = `${project.user_id}/${projectId}.mp4`;
    const fileBuffer = await (await import("node:fs/promises")).readFile(localFile);
    await r2Upload(`source-videos/${storagePath}`, fileBuffer, "video/mp4");

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
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}
