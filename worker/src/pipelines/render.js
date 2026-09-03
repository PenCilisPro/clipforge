import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, setClipStatus, reconcileProjectDone } from "../lib/jobs.js";
import { ensureTmpDir, tmpPath, cleanup, trimSegment, generateThumbnail } from "../lib/ffmpeg.js";
import { buildCaptionsForClip } from "../lib/srt.js";
import { buildEditJson, submitRender, BRAND_HIGHLIGHT } from "../lib/shotstack.js";
import { env } from "../lib/env.js";

async function signedSourceUrl(bucket, path) {
  // Long-lived signed URLs — Shotstack fetches them within minutes, but the
  // extra headroom avoids flaky auth on slow retries.
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, 60 * 60 * 24 * 7);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Stage 4 — render (per clip).
 * 1. Pull source video from storage, trim the segment with FFmpeg
 * 2. Generate a vertical thumbnail
 * 3. Upload raw clip / thumbnail / SRT captions
 * 4. Build the Shotstack Edit JSON (9:16 crop + caption track, brand-orange
 *    word highlight) and submit the render with a webhook callback
 * 5. The Shotstack webhook hits the backend, which enqueues the finalize
 *    stage to download and store the finished MP4 (webhook-only completion).
 */
export async function processRender(job) {
  const { projectId, clipId, jobRowId } = job.data;

  try {
    await setJobStatus(jobRowId, "active");

    const { data: clip, error: clipError } = await supabaseAdmin
      .from("clips")
      .select("*, projects(source_url)")
      .eq("id", clipId)
      .single();
    if (clipError || !clip) throw new Error(`Clip ${clipId} not found`);

    const { data: project, error: projectError } = await supabaseAdmin
      .from("projects")
      .select("id, user_id, original_video_path, transcript_json")
      .eq("id", projectId)
      .single();
    if (projectError || !project) throw new Error(`Project ${projectId} not found`);

    await setClipStatus(clipId, { status: "rendering" });
    await setProjectStatus(projectId, "processing");
    await ensureTmpDir();

    // Already finished by the webhook path? Nothing to do.
    if (clip.storage_path) {
      await reconcileProjectDone(projectId);
      await setJobStatus(jobRowId, "completed");
      return { clipId, skipped: true };
    }

    // 1. Source video → local
    const { data: videoBlob, error: dlError } = await supabaseAdmin.storage
      .from("source-videos")
      .download(project.original_video_path);
    if (dlError) throw dlError;
    const fs = await import("node:fs/promises");
    const localSource = tmpPath(`source-${projectId}.mp4`);
    await fs.writeFile(localSource, Buffer.from(await videoBlob.arrayBuffer()));

    const start = Number(clip.start_time);
    const duration = Math.max(3, Number(clip.end_time) - start);

    // 2. Trim + thumbnail
    const localRawClip = tmpPath(`raw-${clipId}.mp4`);
    await trimSegment(localSource, localRawClip, start, duration);

    const localThumb = tmpPath(`thumb-${clipId}.jpg`);
    await generateThumbnail(localRawClip, localThumb, Math.min(1, duration / 2));

    // 3. Build SRT from word-level timestamps, shifted to clip-local time
    const { srt } = buildCaptionsForClip(project.transcript_json, start, start + duration);

    // 4. Uploads
    const rawPath = `${project.user_id}/raw/${clipId}.mp4`;
    const thumbPath = `${project.user_id}/${clipId}.jpg`;
    const srtPath = `${project.user_id}/srt/${clipId}.srt`;

    const { error: rawUploadError } = await supabaseAdmin.storage
      .from("clips")
      .upload(rawPath, await fs.readFile(localRawClip), { contentType: "video/mp4", upsert: true });
    if (rawUploadError) throw rawUploadError;

    const { error: thumbUploadError } = await supabaseAdmin.storage
      .from("assets")
      .upload(thumbPath, await fs.readFile(localThumb), { contentType: "image/jpeg", upsert: true });
    if (thumbUploadError) throw thumbUploadError;

    const { error: srtUploadError } = await supabaseAdmin.storage
      .from("clips")
      .upload(srtPath, Buffer.from(srt, "utf8"), { contentType: "application/x-subrip", upsert: true });
    if (srtUploadError) throw srtUploadError;

    await supabaseAdmin
      .from("clips")
      .update({ raw_clip_path: rawPath, thumbnail_path: thumbPath, srt_path: srtPath })
      .eq("id", clipId);

    // 5. Shotstack Edit JSON
    const [rawClipUrl, srtUrl] = await Promise.all([
      signedSourceUrl("clips", rawPath),
      signedSourceUrl("clips", srtPath),
    ]);

    const watermarkUrl = process.env.WATERMARK_LOGO_URL || null;
    const editJson = buildEditJson({
      rawClipUrl,
      srtUrl,
      durationSeconds: duration,
      captionStyle: clip.caption_style,
      watermarkUrl,
    });

    // Webhook completion is mandatory: without it the render could never be
    // finalized, so refuse to submit rather than orphan the clip.
    if (!env.shotstackWebhookUrl) {
      throw new Error(
        "SHOTSTACK_WEBHOOK_URL is not configured — set it to https://<backend>/webhooks/shotstack so renders can complete"
      );
    }
    const webhookUrl = `${env.shotstackWebhookUrl}${
      env.shotstackWebhookSecret ? `?secret=${encodeURIComponent(env.shotstackWebhookSecret)}` : ""
    }`;

    const renderId = await submitRender(editJson, webhookUrl);
    job.log(`Shotstack render ${renderId} submitted (highlight ${BRAND_HIGHLIGHT})`);

    await supabaseAdmin
      .from("clips")
      .update({ shotstack_render_id: renderId, status: "rendering" })
      .eq("id", clipId);

    await cleanup(localSource, localRawClip, localThumb);

    // 6. Done from the worker's perspective — completion arrives via the
    // Shotstack webhook (backend /webhooks/shotstack), which enqueues the
    // finalize stage to store the finished MP4.
    await setJobStatus(jobRowId, "completed", null);
    return { clipId, renderId, awaitingWebhook: true };
  } catch (error) {
    await setClipStatus(clipId, { status: "failed", error_message: error.message });
    await setJobStatus(jobRowId, "failed", error.message);
    await reconcileProjectDone(projectId);
    throw error;
  }
}
