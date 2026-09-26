import { supabaseAdmin } from "../lib/supabase.js";
import { r2Key, upload as r2Upload, presignGet, remove as r2Remove } from "../lib/r2.js";
import { setJobStatus, setProjectStatus, setClipStatus, reconcileProjectDone } from "../lib/jobs.js";
import { buildCaptionsForClip, cuesToSrt, parseSrt, attachWordTimings } from "../lib/srt.js";
import { buildRenderSpec, submitRender, renderProviderName } from "../lib/renderProvider.js";
import { planBroll, brollConfigured, isTrustedStockUrl } from "../lib/broll.js";
import { env } from "../lib/env.js";

async function signedSourceUrl(bucket, path) {
  // Long-lived signed URLs — the render provider fetches them within
  // minutes, but the extra headroom avoids flaky auth on slow retries.
  return presignGet(r2Key(bucket, path), 60 * 60 * 24 * 7);
}

/**
 * Stage 4 — render (per clip).
 * 1. Give the remote render provider a signed source URL and trim point (no
 *    local video encode)
 * 2. Upload SRT captions
 * 3. Build the render spec (9:16 crop + caption track) and submit the render
 *    with a completion callback URL
 * 4. The callback hits the backend, which enqueues the finalize stage to
 *    download and store the finished MP4 (callback-only completion).
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
      .select("id, user_id, original_video_path, transcript_json, music_url, music_storage_path, broll_enabled")
      .eq("id", projectId)
      .single();
    if (projectError || !project) throw new Error(`Project ${projectId} not found`);

    await setClipStatus(clipId, { status: "rendering" });
    await setProjectStatus(projectId, "processing");
    const log = (msg) => console.log(`[render ${clipId}] ${msg}`);
    log(`started — source ${project.original_video_path}`);

    // Already finished by the webhook path? Nothing to do.
    if (clip.storage_path) {
      await reconcileProjectDone(projectId);
      await setJobStatus(jobRowId, "completed");
      return { clipId, skipped: true };
    }

    if (!project.original_video_path?.startsWith(`${project.user_id}/`)) {
      throw new Error("Source video path does not belong to the project owner");
    }
    const start = Number(clip.start_time);
    const duration = Math.max(3, Number(clip.end_time) - start);
    const sourceVideoUrl = await signedSourceUrl("source-videos", project.original_video_path);

    // 3. Captions — manual edits from the clip editor win; otherwise
    // regenerate from word-level timestamps, shifted to clip-local time.
    // Rendered as HTML text clips (font + style aware), placed as the
    // topmost track inside buildEditJson. Word timings ride along so the
    // currently-spoken word can be accented (word-sync highlight).
    const captionCues = clip.srt_override
      ? attachWordTimings(parseSrt(clip.srt_override), project.transcript_json, start, start + duration)
      : buildCaptionsForClip(project.transcript_json, start, start + duration).cues;
    // Stored alongside the clip (clip editor reads it back).
    const srtText = clip.srt_override ?? cuesToSrt(captionCues);

    // 3b. B-roll — an editor plan (clips.broll_json) wins:
    //   null = plan fresh with AI at render time (only when the project's
    //   broll_enabled toggle is on), [] = explicitly none.
    //   Editor plans may hold up to 8 manually-picked segments: stock URLs
    //   (pexels/pixabay) or the user's own MP4 uploads ("storage:..." refs).
    const resolveBrollSrc = async (src) => {
      const match = String(src).match(/^storage:user-uploads\/(.+)$/);
      if (!match) return String(src);
      // Service role bypasses storage RLS — only sign the project owner's
      // own uploads, never another user's folder.
      if (!match[1].startsWith(`${project.user_id}/broll/`)) {
        throw new Error(`B-roll path does not belong to the project owner: ${match[1]}`);
      }
      return await signedSourceUrl("user-uploads", match[1]);
    };
    let brollClips = [];
    if (Array.isArray(clip.broll_json)) {
      const ownStoragePrefix = `storage:user-uploads/${project.user_id}/broll/`;
      brollClips = clip.broll_json
        .filter(
          (b) =>
            b &&
            Number.isFinite(Number(b.start)) &&
            Number(b.end) > Number(b.start) &&
            (isTrustedStockUrl(b.src) || String(b.src).startsWith(ownStoragePrefix))
        )
        .slice(0, 8);
      brollClips = await Promise.all(
        brollClips.map(async (b) => ({
          start: Number(b.start),
          end: Number(b.end),
          src: await resolveBrollSrc(b.src),
        }))
      );
      job.log(`B-roll: using ${brollClips.length} editor-planned segment(s)`);
    } else if (project.broll_enabled !== false && brollConfigured()) {
      brollClips = await planBroll({
        transcriptJson: project.transcript_json,
        clipStart: start,
        clipEnd: start + duration,
        durationSeconds: duration,
        log: (msg) => job.log(msg),
      });
    }

    // Keep the large source in R2; the render provider trims it remotely so
    // worker CPU, RAM, and disk use do not scale with source size or clip count.
    const srtPath = `${project.user_id}/srt/${clipId}.srt`;
    await r2Upload(r2Key("clips", srtPath), Buffer.from(srtText, "utf8"), "application/x-subrip");
    log("captions uploaded");

    // Music: a Jamendo URL is fetched directly; an uploaded MP3 is signed —
    // but only if it lives in the project owner's own uploads folder.
    let musicUrl = project.music_url;
    if (!musicUrl && project.music_storage_path) {
      if (String(project.music_storage_path).startsWith(`${project.user_id}/music/`)) {
        musicUrl = await signedSourceUrl("user-uploads", project.music_storage_path);
      } else {
        job.log("Ignoring music_storage_path — path is outside the project owner's folder");
      }
    }

    const watermarkUrl = process.env.WATERMARK_LOGO_URL || null;
    const renderSpec = buildRenderSpec({
      sourceVideoUrl,
      sourceTrimSeconds: start,
      durationSeconds: duration,
      watermarkUrl,
      brollClips,
      musicTrack: musicUrl ? { url: musicUrl } : null,
      captionCues,
      captionFontKey: clip.caption_font,
      captionStyle: clip.caption_style,
      captionTextColor: clip.caption_color ?? "#ffffff",
      captionStroke: clip.caption_stroke === true,
      captionShadow: clip.caption_shadow === true,
      captionStrokeColor: clip.caption_stroke_color ?? "#000000",
      captionStrokeSize: Number(clip.caption_stroke_size) || 4,
      captionShadowColor: clip.caption_shadow_color ?? "#000000",
      captionShadowSize: Number(clip.caption_shadow_size) || 6,
    });

    // Webhook completion is mandatory: without it the render could never be
    // finalized, so refuse to submit rather than orphan the clip.
    if (!env.renderWebhookUrl) {
      throw new Error(
        "RENDER_WEBHOOK_URL is not configured — set it to https://<backend>/webhooks/render so renders can complete"
      );
    }
    const webhookUrl = `${env.renderWebhookUrl}${
      env.renderWebhookSecret ? `?secret=${encodeURIComponent(env.renderWebhookSecret)}` : ""
    }`;

    const provider = renderProviderName();
    const renderId = await submitRender(renderSpec, webhookUrl);
    log(`${provider} render ${renderId} submitted`);

    await supabaseAdmin
      .from("clips")
      .update({
        // shotstack_render_id is the legacy field the recovery queries and
        // composite indexes already use — mirror the id there so clips
        // rendered on any provider stay recoverable without a migration.
        render_id: renderId,
        render_provider: provider,
        shotstack_render_id: renderId,
        raw_clip_path: null,
        thumbnail_path: null,
        srt_path: srtPath,
        status: "rendering",
        render_submitted_at: new Date().toISOString(),
      })
      .eq("id", clipId);

    if (clip.raw_clip_path?.startsWith(`${project.user_id}/`)) {
      await r2Remove([r2Key("clips", clip.raw_clip_path)]).catch(() => {});
    }

    // 6. Done from the worker's perspective — completion arrives via the
    // render webhook (backend /webhooks/render), which enqueues the
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
