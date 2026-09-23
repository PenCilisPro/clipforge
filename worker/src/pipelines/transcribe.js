import fs from "node:fs/promises";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, deductCredits, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import { ensureTmpDir, tmpPath, cleanup, extractAudio, probeDurationSeconds, probeStreams } from "../lib/ffmpeg.js";
import { fetchSourceVideo, isSplitSource, sourceStoragePaths } from "../lib/source.js";
import { uploadFile as r2UploadFile, remove as r2Remove } from "../lib/r2.js";
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
 * Processes bounded mono 16 kHz WAV chunks serially, so long sources do not
 * require a full-length PCM WAV or concurrent base64 request buffers in RAM.
 */
export async function processTranscribe(job) {
  const { projectId, jobRowId } = job.data;
  let localVideo = null;
  const chunkFiles = [];

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

    // 1. Pull source video out of storage (reassembles split uploads)
    localVideo = tmpPath(`source-${projectId}.mp4`);
    await fetchSourceVideo(project, localVideo);
    if (isSplitSource(project.original_video_path)) {
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
    }

    const hasAudio = (await probeStreams(localVideo).catch(() => [])).some(
      (stream) => stream.codec_type === "audio"
    );
    if (!hasAudio) {
      throw new Error(
        "This video has no audio track — it looks like a video-only download " +
          "(filenames ending in .fNNN, e.g. .f401). Re-download with audio merged " +
          "(yt-dlp's default format selection does this) and re-upload."
      );
    }

    const durationSeconds =
      await probeDurationSeconds(localVideo).catch(() => project.duration_seconds ?? null);
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

    // 2. Extract short audio segments and transcribe them one at a time.
    // A full-length PCM WAV takes ~115 MB per hour on disk, and putting that
    // audio plus base64 payload and concurrent STT requests in RAM can exceed
    // Northflank's 512 MB limit. Keep at most one 55-second payload resident.
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

    const chunkSeconds = 55;
    const words = [];
    const transcriptParts = [];
    const client = await getSpeechClient();
    let chunkIndex = 0;
    for (let start = 0; start < durationSeconds; start += chunkSeconds) {
      const chunkPath = tmpPath(`audio-${projectId}-${start}.wav`);
      chunkFiles.push(chunkPath);
      try {
        await extractAudio(
          localVideo,
          chunkPath,
          start,
          Math.min(chunkSeconds, durationSeconds - start)
        );
        const audioBuffer = await fs.readFile(chunkPath);
        const [operation] = await client.longRunningRecognize({
          audio: { content: audioBuffer.toString("base64") },
          config,
        });
        audioBuffer.fill(0);
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
        await cleanup(chunkPath);
        chunkFiles.pop();
      } catch (error) {
        await cleanup(chunkPath);
        chunkFiles.pop();
        throw error;
      }
      chunkIndex++;
      job.log(
        `Transcribed segment ${chunkIndex} (${Math.min(start + chunkSeconds, durationSeconds).toFixed(0)} / ${durationSeconds.toFixed(0)}s)`
      );
    }

    if (words.length === 0) {
      throw new Error("Transcription produced no words — is there speech in this video?");
    }

    const transcriptJson = { transcript: transcriptParts.join(" "), words };
    const { error: updateError } = await supabaseAdmin
      .from("projects")
      .update({ transcript_json: transcriptJson })
      .eq("id", projectId);
    if (updateError) throw updateError;

    await cleanup(localVideo);
    localVideo = null;

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
    await cleanup(localVideo, ...chunkFiles);
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}
