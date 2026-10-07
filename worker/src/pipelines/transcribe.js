import fs from "node:fs/promises";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, deductCredits, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import { ensureTmpDir, tmpPath, cleanup, extractRawPcm, probeMedia } from "../lib/ffmpeg.js";
import { fetchSourceVideo, isSplitSource, sourceStoragePaths } from "../lib/source.js";
import { uploadFile as r2UploadFile, remove as r2Remove, presignGet, r2Key } from "../lib/r2.js";
import { env } from "../lib/env.js";

// The Google speech SDK is heavy; load it only when a transcription job
// needs it so the long-lived worker keeps more headroom inside the 512 MB
// service while it handles queue and render-completion jobs.
let speechClient = null;

function googleAuthOptions() {
  if (env.googleCredentialsJson) {
    return { credentials: JSON.parse(env.googleCredentialsJson) };
  }
  if (env.googleCredentialsPath) {
    return { keyFilename: env.googleCredentialsPath };
  }
  return {};
}

async function getSpeechClient() {
  if (speechClient) return speechClient;
  const speech = (await import("@google-cloud/speech")).default;
  speechClient = new speech.SpeechClient(googleAuthOptions());
  return speechClient;
}

/**
 * Stage 2 — transcribe.
 * Extracts the audio in a single ffmpeg pass into raw mono 16 kHz PCM, then
 * transcribes fixed 55-second byte ranges serially — one STT request at a
 * time and at most one chunk payload in RAM, so neither CPU, memory, nor
 * disk scale with the number of chunks.
 */
export async function processTranscribe(job) {
  const { projectId, jobRowId } = job.data;
  let localVideo = null;
  let pcmFile = null;

  try {
    await setJobStatus(jobRowId, "active");

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("id, user_id, original_video_path, duration_seconds, project_mode")
      .eq("id", projectId)
      .single();
    if (error || !project?.original_video_path) {
      throw new Error("Source video not found — download/upload must run first");
    }

    await ensureTmpDir();

    // 1. Hand ffmpeg the shortest path to the audio. The container has only
    //    ~1 GiB of ephemeral disk, so a source-sized MP4 must NOT land here:
    //    - regular uploads: presign the R2 object and let ffprobe/ffmpeg
    //      stream it over HTTP — the file never touches local disk at all;
    //    - split uploads (legacy multipart path): the parts must be
    //      reassembled locally, merged into one object, then processed.
    let mediaSource; // local file path OR presigned https URL
    if (!isSplitSource(project.original_video_path)) {
      // Same ownership guard fetchSourceVideo enforces for downloads — the
      // presigned URL would otherwise bypass it.
      if (!String(project.original_video_path).startsWith(`${project.user_id}/`)) {
        throw new Error("Source video path does not belong to the project owner");
      }
      // TTL covers the whole stage (extraction + chunked STT loop).
      mediaSource = await presignGet(
        r2Key("source-videos", project.original_video_path),
        6 * 60 * 60
      );
    } else {
      localVideo = tmpPath(`source-${projectId}.mp4`);
      await fetchSourceVideo(project, localVideo);
      const previousPath = project.original_video_path;
      const canonicalPath = `${project.user_id}/${projectId}.mp4`;
      await r2UploadFile(`source-videos/${canonicalPath}`, localVideo, "video/mp4");
      const { error: pathError } = await supabaseAdmin
        .from("projects")
        .update({ original_video_path: canonicalPath })
        .eq("id", projectId);
      if (pathError) throw pathError;
      project.original_video_path = canonicalPath;
      const oldPaths = await sourceStoragePaths(previousPath);
      await r2Remove(oldPaths.map((sourcePath) => `source-videos/${sourcePath}`)).catch((err) => {
        console.warn(`[transcribe] could not remove split source parts: ${err.message}`);
      });
      mediaSource = localVideo;
    }

    const probe = await probeMedia(mediaSource).catch(() => null);
    const hasAudio = (probe?.streams ?? []).some((stream) => stream.codec_type === "audio");
    if (!hasAudio) {
      throw new Error(
        "This video has no audio track — it looks like a video-only download " +
          "(filenames ending in .fNNN, e.g. .f401). Re-download with audio merged " +
          "(yt-dlp's default format selection does this) and re-upload."
      );
    }

    const durationSeconds =
      probe && probe.duration > 0 ? probe.duration : project.duration_seconds ?? null;
    if (!durationSeconds || !Number.isFinite(durationSeconds)) {
      throw new Error("Could not determine the source video duration");
    }
    // Credits are per processed video, not per retry — only the first
    // attempt pays, otherwise each failed retry burns more minutes.
    if (durationSeconds && !job.attemptsMade) {
      await supabaseAdmin
        .from("projects")
        .update({ duration_seconds: durationSeconds })
        .eq("id", projectId);
      await deductCredits(project.user_id, durationSeconds);
    }

    // 2. Extract the audio once, then slice it in memory. A full-length PCM
    // WAV takes ~115 MB per hour on disk, and re-running ffmpeg on a
    // source-sized video once per 55-second chunk would saturate the
    // constrained 0.2 vCPU service for the whole transcription. One pass
    // writes raw mono 16 kHz PCM; each STT request then reads a fixed byte
    // range (32 000 B/s × 55 s ≈ 1.7 MB, well under Google's 10 MiB inline
    // and 60 s limits) through a single reused buffer.
    pcmFile = tmpPath(`audio-${projectId}.pcm`);
    await extractRawPcm(mediaSource, pcmFile);
    // The source is no longer needed locally — render works off the R2
    // object — so free its disk before the long transcription loop. (Only
    // the split path ever had a local file; cleanup(null) is a no-op.)
    await cleanup(localVideo);
    localVideo = null;

    const BYTES_PER_SECOND = 16000 * 2; // 16 kHz × 16-bit mono
    const chunkSeconds = 55;
    const chunkBytes = chunkSeconds * BYTES_PER_SECOND;
    const { size: pcmBytes } = await fs.stat(pcmFile);
    const chunkCount = Math.ceil(pcmBytes / chunkBytes);

    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: env.sttLanguage,
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      model: "latest_long",
    };
    const toSeconds = (time) =>
      time == null
        ? 0
        : typeof time === "number"
          ? time
          : Number(time.seconds ?? 0) + Number(time.nanos ?? 0) / 1e9;

    const words = [];
    const transcriptParts = [];
    const client = await getSpeechClient();
    const pcm = await fs.open(pcmFile, "r");
    const buffer = Buffer.alloc(chunkBytes);
    try {
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const start = chunkIndex * chunkSeconds;
        const { bytesRead } = await pcm.read(buffer, 0, chunkBytes, chunkIndex * chunkBytes);
        const [operation] = await client.longRunningRecognize({
          audio: { content: buffer.subarray(0, bytesRead).toString("base64") },
          config,
        });
        const [response] = await operation.promise();
        for (const result of response.results ?? []) {
          const alternative = result.alternatives?.[0];
          if (!alternative) continue;
          transcriptParts.push(alternative.transcript);
          for (const word of alternative.words ?? []) {
            words.push({
              word: word.word,
              start: toSeconds(word.startTime) + start,
              end: toSeconds(word.endTime) + start,
            });
          }
        }
        job.log(
          `Transcribed segment ${chunkIndex + 1} (${Math.min(start + chunkSeconds, durationSeconds).toFixed(0)} / ${durationSeconds.toFixed(0)}s)`
        );
      }
    } finally {
      await pcm.close().catch(() => {});
    }

    await cleanup(pcmFile);
    pcmFile = null;

    if (words.length === 0) {
      throw new Error("Transcription produced no words — is there speech in this video?");
    }

    const transcriptJson = { transcript: transcriptParts.join(" "), words };
    const { error: updateError } = await supabaseAdmin
      .from("projects")
      .update({ transcript_json: transcriptJson })
      .eq("id", projectId);
    if (updateError) throw updateError;

    if (project.project_mode === "transcript") {
      await setProjectStatus(projectId, "done");
      await setJobStatus(jobRowId, "completed");
      job.log(`Transcript ready (${words.length} words) — transcript-only project, done.`);
      return { projectId, wordCount: words.length, transcriptOnly: true };
    }

    await setJobStatus(jobRowId, "completed");
    const analyzeJobRowId = await insertJobRow(projectId, "analyze");
    await enqueuePipeline("analyze", { projectId, jobRowId: analyzeJobRowId });
    job.log(`Transcribed ${words.length} words`);
    return { projectId, wordCount: words.length };
  } catch (error) {
    // Clean partial media even if download, extraction, or STT fails.
    await cleanup(localVideo, pcmFile);
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}
