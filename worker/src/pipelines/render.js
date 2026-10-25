import { supabaseAdmin } from "../lib/supabase.js";
import { r2Key, upload as r2Upload, presignGet, remove as r2Remove } from "../lib/r2.js";
import { setJobStatus, setProjectStatus, setClipStatus, reconcileProjectDone } from "../lib/jobs.js";
import {
  buildCaptionsForClip,
  cuesToSrt,
  parseSrt,
  attachWordTimings,
  sanitizeSegments,
  remapCuesToSegments,
  remapWindowToSegments,
} from "../lib/srt.js";
import { buildRenderSpec, submitRender, renderProviderName } from "../lib/renderProvider.js";
import { planBroll, brollConfigured, isTrustedStockUrl } from "../lib/broll.js";
import { env } from "../lib/env.js";
import { finalizeClip } from "./finalize.js";

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
/**
 * Clip Intelligence edit list (absolute source seconds): the AI may keep
 * several ranges inside the clip window and skip what it judged boring in
 * between — scene stitches and dead-air cuts alike. intel_json is the
 * transport (no schema migration needed); a future clips.segments column,
 * if one is added manually, wins over it.
 */
function resolveClipSegments(clip) {
  if (Array.isArray(clip?.segments) && clip.segments.length > 0) return clip.segments;
  let intel = clip?.intel_json;
  if (typeof intel === "string") {
    try { intel = JSON.parse(intel); } catch { return null; }
  }
  const segs = intel?.edit?.segments;
  return Array.isArray(segs) && segs.length > 0 ? segs : null;
}

/**
 * Text overlays ("+ Add text" in the clip editor): editor-placed standalone
 * text, burned by the local/Modal ASS renderer with the caption mechanics —
 * px scaling on the output canvas, block-center % positioning, and the same
 * BorderStyle-3 box recipe as the caption templates. Cloud providers ignore
 * the field. Sanitized here so a tampered DB row can't inject arbitrary
 * shapes into the renderer.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function sanitizeTextOverlays(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw.slice(0, 10)) {
    const text = String(o?.text ?? "").replace(/\r\n?/g, "\n").slice(0, 500);
    if (!text.trim()) continue;
    out.push({
      text,
      font: typeof o?.font === "string" && o.font.trim() ? o.font.trim().slice(0, 40) : "poppins",
      x: Math.min(100, Math.max(0, Number.isFinite(Number(o?.x)) ? Number(o.x) : 50)),
      y: Math.min(100, Math.max(0, Number.isFinite(Number(o?.y)) ? Number(o.y) : 50)),
      size: Math.min(200, Math.max(20, Math.round(Number(o?.size) || 60))),
      width: Math.min(100, Math.max(20, Number(o?.width) || 90)),
      color: HEX_COLOR_RE.test(String(o?.color ?? "")) ? String(o.color) : "#ffffff",
      bold: o?.bold !== false,
      bg: o?.bg === true,
    });
  }
  return out;
}

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

    // Scene cuts: keep only the AI-selected ranges and skip what it judged
    // boring in between. The renderer concat-keeps these ranges; captions and
    // b-roll windows re-time onto the merged timeline. Clips without an edit
    // list render the contiguous window exactly as before.
    const segments = sanitizeSegments(resolveClipSegments(clip), start, start + duration);
    const outputDuration = segments
      ? segments.reduce((s, seg) => s + (seg.end - seg.start), 0)
      : duration;
    if (segments) {
      log(
        `scene cuts: ${segments.length} kept range(s), ${(duration - outputDuration).toFixed(1)}s of ${duration.toFixed(0)}s skipped`
      );
    }

    // 3. Captions — manual edits from the clip editor win; otherwise
    // regenerate from word-level timestamps, shifted to clip-local time.
    // Rendered as HTML text clips (font + style aware), placed as the
    // topmost track inside buildEditJson. Word timings ride along so the
    // currently-spoken word can be accented (word-sync highlight).
    const captionCuesRaw = clip.srt_override
      ? attachWordTimings(parseSrt(clip.srt_override), project.transcript_json, start, start + duration)
      : buildCaptionsForClip(project.transcript_json, start, start + duration).cues;
    // Cues are built against the contiguous window; with scene cuts they must
    // land on the merged timeline the viewer actually watches.
    const captionCues = segments
      ? remapCuesToSegments(captionCuesRaw, segments, start)
      : captionCuesRaw;
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

    // B-roll windows are planned against the contiguous window; re-time them
    // onto the merged timeline and drop cutaways that land inside a skip.
    if (segments && brollClips.length > 0) {
      const before = brollClips.length;
      const remapped = [];
      for (const b of brollClips) {
        const w = remapWindowToSegments(b.start, b.end, segments, start);
        if (w) remapped.push({ ...b, ...w });
      }
      brollClips = remapped;
      if (brollClips.length !== before) job.log(`B-roll: ${before - brollClips.length} cutaway(s) fell inside a scene skip`);
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
    const renderSpecParams = {
      sourceVideoUrl,
      sourceTrimSeconds: start,
      // The viewer watches the merged timeline: with scene cuts this is the
      // sum of the kept ranges, not the window length.
      durationSeconds: outputDuration,
      // Edit decision list (absolute source seconds). The local/Modal ffmpeg
      // renderer concat-keeps these ranges; cloud providers ignore it.
      ...(segments ? { segments } : {}),
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
      // 9:16 layout: "cover" zooms a landscape source to fill the canvas
      // (cropped); "contain" keeps the whole frame visible over a blurred
      // zoomed copy of itself (plain black bars when the blur is off).
      videoFit: clip.video_fit === "contain" ? "contain" : "cover",
      videoBackgroundBlur: clip.video_background_blur !== false,
      // CapCut-style frame zoom & pan (editor "Frame" tab). video_scale is %
      // of the fitted frame (100 = untouched), video_x/y are pan offsets as %
      // of the output canvas. The local/Modal renderer scales the fitted
      // frame about the canvas center and shifts the visible window, clamped
      // to what the zoomed frame can show (the editor's videoMaxPan);
      // captions/overlays burn AFTER the transform, so text stays put —
      // mirroring the editor, whose overlay layer sits outside the
      // transformed video element.
      videoScale: Math.min(300, Math.max(50, Number(clip.video_scale) || 100)),
      videoX: Number.isFinite(Number(clip.video_x))
        ? Math.min(50, Math.max(-50, Number(clip.video_x)))
        : 0,
      videoY: Number.isFinite(Number(clip.video_y))
        ? Math.min(50, Math.max(-50, Number(clip.video_y)))
        : 0,
      // Caption placement (top/middle/bottom) + explicit px size (0 =
      // template default), and the output canvas aspect from the editor.
      captionPosition: clip.caption_position ?? "bottom",
      captionSize: Number(clip.caption_size) || 0,
      captionWordSpacing: Number(clip.caption_word_spacing) || 0,
      captionLetterSpacing: Number(clip.caption_letter_spacing) || 0,
      // Caption drag position (editor caption_x/caption_y, % of canvas, block
      // center) and animation id — consumed by the local/Modal ASS renderer.
      captionX: Number.isFinite(Number(clip.caption_x)) ? Number(clip.caption_x) : null,
      captionY: Number.isFinite(Number(clip.caption_y)) ? Number(clip.caption_y) : null,
      captionAnim:
        typeof clip.caption_anim === "string" && clip.caption_anim.trim()
          ? clip.caption_anim.trim()
          : "pop",
      // Caption wrap width (editor slider, % of canvas — the live preview's
      // max-width box). The local ASS renderer turns it into symmetric
      // wrap margins; the cloud providers ignore it.
      captionWidth: Number(clip.caption_width) || 90,
      // "Words per screen" regrouping (editor slider 0-12; 0 = off). The
      // local/Modal ASS renderer re-chunks captionCues into blocks of exactly
      // N timed words, mirroring the preview's regroupCuesForDisplay. Cloud
      // providers ignore the field.
      captionWords: Math.max(0, Math.min(12, Math.round(Number(clip.caption_words) || 0))),
      // Editor text overlays ("+ Add text") — local/Modal only, see
      // sanitizeTextOverlays above.
      textOverlays: sanitizeTextOverlays(clip.text_overlays),
      outputAspect: clip.output_aspect ?? "9:16",
    };

    // Webhook completion is mandatory for the cloud providers: without it the
    // render could never be finalized, so refuse to submit rather than orphan
    // the clip. The local provider renders inline and finalizes below, so it
    // needs no webhook at all.
    const provider = renderProviderName();
    let webhookUrl = null;
    if (provider !== "local") {
      if (!env.renderWebhookUrl) {
        throw new Error(
          "RENDER_WEBHOOK_URL is not configured — set it to https://<backend>/webhooks/render so renders can complete"
        );
      }
      webhookUrl = `${env.renderWebhookUrl}${
        env.renderWebhookSecret ? `?secret=${encodeURIComponent(env.renderWebhookSecret)}` : ""
      }`;
    }

    // renderSpec carries clipId for the local provider; the cloud providers
    // ignore the extra param (their spec builders pick only known keys).
    const renderId = await submitRender(
      buildRenderSpec({ ...renderSpecParams, clipId }),
      webhookUrl,
      { clipId }
    );
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

    // 6. Local renders finished inside submitRender — finalize right here so
    // the clip goes straight to "ready" (no webhook, no separate job).
    if (provider === "local") {
      log("local render finished — finalizing");
      return {
        clipId,
        renderId,
        ...(await finalizeClip({ projectId, clipId, renderUrl: `local:${renderId}`, jobRowId })),
      };
    }

    // Done from the worker's perspective — completion arrives via the
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
